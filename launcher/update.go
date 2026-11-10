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

func latestRelease() (*release, error) {
	if repo == "" {
		return nil, errors.New("адрес обновлений не настроен")
	}
	c := &http.Client{Timeout: 15 * time.Second}
	req, _ := http.NewRequest("GET", "https://api.github.com/repos/"+repo+"/releases/latest", nil)
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
	u, size := r.exeAsset()
	if u == "" {
		return errors.New("в версии на GitHub нет exe")
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if p, e := filepath.EvalSymlinks(self); e == nil {
		self = p
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
	f, err := os.Create(tmp)
	if err != nil {
		return errors.New("нет прав на запись в папку программы: " + dir)
	}
	n, err := io.Copy(f, io.LimitReader(resp.Body, 200<<20))
	f.Close()
	if err != nil || (size > 0 && n != size) || n < 1<<20 {
		os.Remove(tmp)
		return errors.New("файл скачался не полностью, попробуйте ещё раз")
	}
	if b, _ := os.ReadFile(tmp); len(b) < 2 || b[0] != 'M' || b[1] != 'Z' {
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
	if err := cmd.Start(); err != nil {
		return errors.New("новая версия не запустилась: " + err.Error())
	}
	return nil
}

// остаток прошлого обновления
func cleanupOld() {
	if self, err := os.Executable(); err == nil {
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
