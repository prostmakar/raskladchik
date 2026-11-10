package main

// Обновление из GitHub: последний релиз репозитория (repo подставляет build.py),
// скачивание .exe, подмена самого себя и перезапуск.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// "владелец/репозиторий" на GitHub (подставляет build.py из release.json)
var repo = ""

// адрес API GitHub (переменная окружения — только для проверки обновления на тестовом сервере)
func apiBase() string {
	if b := os.Getenv("RASKLADCHIK_TEST_API"); b != "" {
		return b
	}
	return "https://api.github.com"
}

type release struct {
	Tag    string `json:"tag_name"`
	Name   string `json:"name"`
	Body   string `json:"body"`
	Assets []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
		Size int64  `json:"size"`
	} `json:"assets"`
}

// "v1.12" -> [1 12]
func verParts(v string) []int {
	v = strings.TrimPrefix(strings.TrimSpace(strings.ToLower(v)), "v")
	var out []int
	for _, p := range strings.Split(v, ".") {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil
		}
		out = append(out, n)
	}
	return out
}

func newer(a, b string) bool { // a новее b
	pa, pb := verParts(a), verParts(b)
	if pa == nil || pb == nil {
		return false
	}
	for i := 0; i < len(pa) || i < len(pb); i++ {
		x, y := 0, 0
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			return x > y
		}
	}
	return false
}

func ghGet(path string, v any) error {
	if repo == "" {
		return errors.New("адрес обновлений не настроен")
	}
	c := &http.Client{Timeout: 15 * time.Second}
	req, _ := http.NewRequest("GET", apiBase()+"/repos/"+repo+path, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "Raskladchik-updater")
	resp, err := c.Do(req)
	if err != nil {
		return errors.New("нет связи с GitHub")
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return errors.New("на GitHub пока нет версий")
	}
	if resp.StatusCode != 200 {
		return fmt.Errorf("GitHub ответил %d", resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(v)
}

// предыдущая версия: самая новая из тех, что старше текущей (с exe)
func prevRelease() (*release, error) {
	var all []release
	if err := ghGet("/releases?per_page=50", &all); err != nil {
		return nil, err
	}
	var best *release
	for i := range all {
		r := &all[i]
		if u, _ := r.exeAsset(); u == "" || !newer(version, r.Tag) {
			continue
		}
		if best == nil || newer(r.Tag, best.Tag) {
			best = r
		}
	}
	if best == nil {
		return nil, errors.New("предыдущей версии на GitHub нет")
	}
	return best, nil
}

func latestRelease() (*release, error) {
	if repo == "" {
		return nil, errors.New("адрес обновлений не настроен")
	}
	c := &http.Client{Timeout: 15 * time.Second}
	req, _ := http.NewRequest("GET", apiBase()+"/repos/"+repo+"/releases/latest", nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "Raskladchik-updater")
	resp, err := c.Do(req)
	if err != nil {
		return nil, errors.New("нет связи с GitHub")
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return nil, errors.New("на GitHub пока нет версий")
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("GitHub ответил %d", resp.StatusCode)
	}
	var r release
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&r); err != nil {
		return nil, err
	}
	return &r, nil
}

func (r *release) exeAsset() (string, int64) {
	for _, a := range r.Assets {
		if strings.HasSuffix(strings.ToLower(a.Name), ".exe") {
			return a.URL, a.Size
		}
	}
	return "", 0
}

type checkResult struct {
	Current string `json:"current"`
	Latest  string `json:"latest,omitempty"`
	Newer   bool   `json:"newer"`
	Prev    string `json:"prev,omitempty"`
	Notes   string `json:"notes,omitempty"`
	Err     string `json:"err,omitempty"`
}

func checkUpdate() checkResult {
	res := checkResult{Current: version}
	r, err := latestRelease()
	if err != nil {
		res.Err = err.Error()
		return res
	}
	res.Latest = strings.TrimPrefix(r.Tag, "v")
	res.Notes = r.Body
	u, _ := r.exeAsset()
	res.Newer = newer(r.Tag, version) && u != ""
	if p, err := prevRelease(); err == nil {
		res.Prev = strings.TrimPrefix(p.Tag, "v")
	}
	return res
}

// скачать новую версию рядом со своим exe, подменить себя и запустить новую
func applyUpdate() error {
	r, err := latestRelease()
	if err != nil {
		return err
	}
	if !newer(r.Tag, version) {
		return errors.New("уже последняя версия")
	}
	return install(r)
}

// установить выбранную версию (из списка «Что нового»)
func applyVersion(ver string) error {
	if verParts(ver) == nil {
		return errors.New("неверный номер версии")
	}
	var r release
	if err := ghGet("/releases/tags/v"+strings.TrimPrefix(ver, "v"), &r); err != nil {
		return err
	}
	if !newer(r.Tag, version) && !newer(version, r.Tag) {
		return errors.New("эта версия уже установлена")
	}
	return install(&r)
}

// вернуться на предыдущую версию (последнюю из тех, что старше текущей)
func applyPrev() (string, error) {
	r, err := prevRelease()
	if err != nil {
		return "", err
	}
	return strings.TrimPrefix(r.Tag, "v"), install(r)
}

func install(r *release) error {
	u, size := r.exeAsset()
	if u == "" {
		return errors.New("в версии на GitHub нет exe")
	}
	self := selfPath
	if self == "" {
		return errors.New("не удалось определить, где лежит программа")
	}
	dir := filepath.Dir(self)
	tmp := filepath.Join(dir, ".raskladchik-new.exe")
	c := &http.Client{Timeout: 10 * time.Minute}
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", "Raskladchik-updater")
	resp, err := c.Do(req)
	if err != nil {
		return errors.New("не удалось скачать: нет связи")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("не удалось скачать: GitHub ответил %d", resp.StatusCode)
	}
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return errors.New("нет прав на запись в папку программы: " + dir)
	}
	n, err := io.Copy(f, io.LimitReader(resp.Body, 200<<20))
	f.Close()
	if err != nil || (size > 0 && n != size) || n < 1<<20 {
		os.Remove(tmp)
		return errors.New("файл скачался не полностью, попробуйте ещё раз")
	}
	if b, _ := os.ReadFile(tmp); os.Getenv("RASKLADCHIK_TEST_API") == "" && (len(b) < 2 || b[0] != 'M' || b[1] != 'Z') {
		os.Remove(tmp)
		return errors.New("скачанный файл — не программа")
	}
	old := self + ".old"
	os.Remove(old)
	if err := os.Rename(self, old); err != nil { // работающий exe в Windows переименовать можно, удалить — нет
		os.Remove(tmp)
		return errors.New("не удалось заменить программу: " + err.Error())
	}
	if err := os.Rename(tmp, self); err != nil {
		os.Rename(old, self)
		return errors.New("не удалось заменить программу: " + err.Error())
	}
	cmd := exec.Command(self, "--after-update")
	cmd.Dir = dir
	if err := cmd.Start(); err != nil { // вернуть как было
		os.Remove(self)
		os.Rename(old, self)
		return errors.New("новая версия не запустилась: " + err.Error())
	}
	return nil
}

// путь к своему exe — запоминается при запуске (после переименования при обновлении он уже другой)
var selfPath string

// остаток прошлого обновления
func cleanupOld() {
	if self, err := os.Executable(); err == nil {
		if p, e := filepath.EvalSymlinks(self); e == nil {
			self = p
		}
		selfPath = self
		go func() {
			for i := 0; i < 20; i++ {
				if err := os.Remove(self + ".old"); err == nil || os.IsNotExist(err) {
					return
				}
				time.Sleep(time.Second)
			}
		}()
	}
}
