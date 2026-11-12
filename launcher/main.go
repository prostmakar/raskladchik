// Раскладчик — запускатель окна приложения (Windows).
// Встраивает страницу и открывает её в отдельном окне Edge (режим приложения).
// Страница отдаётся с локального адреса 127.0.0.1 (наружу ничего не открывается),
// чтобы программа могла сохранять исправленные чертежи в папку на рабочем столе.
package main

import (
	"crypto/rand"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

//go:embed app.html
var page string

const port = 47817

// версия сборки (подставляет build.py); при запуске новой версии старая уступает место
var version = "dev"

const title = "Раскладчик"

type startFile struct {
	Name string  `json:"name"`
	Path string  `json:"path,omitempty"` // где лежит файл (проект помнит путь, чтобы открыть чертёж потом)
	Text *string `json:"text,omitempty"`
	B64  string  `json:"b64,omitempty"`
	Err  string  `json:"err,omitempty"`
}

func findBrowser() (string, bool) {
	var cands []string
	for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"} {
		if b := os.Getenv(env); b != "" {
			cands = append(cands, filepath.Join(b, "Microsoft", "Edge", "Application", "msedge.exe"))
		}
	}
	for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"} {
		if b := os.Getenv(env); b != "" {
			cands = append(cands, filepath.Join(b, "Google", "Chrome", "Application", "chrome.exe"))
		}
	}
	for _, c := range cands {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c, true
		}
	}
	return "", false
}

// файлы, перетащенные на значок .exe
func readArgs() []startFile {
	var files []startFile
	for _, a := range os.Args[1:] {
		if abs, err := filepath.Abs(a); err == nil {
			a = abs
		}
		name := filepath.Base(a)
		b, err := os.ReadFile(a)
		if err != nil {
			files = append(files, startFile{Name: name, Err: "Не удалось прочитать файл"})
			continue
		}
		ext := strings.ToLower(filepath.Ext(name))
		if ext == ".x_t" || ext == ".xmt_txt" {
			r := make([]rune, len(b))
			for i, c := range b {
				r[i] = rune(c)
			}
			t := string(r)
			files = append(files, startFile{Name: name, Path: a, Text: &t})
		} else {
			files = append(files, startFile{Name: name, Path: a, B64: base64.StdEncoding.EncodeToString(b)})
		}
	}
	return files
}

func pageWith(files []startFile) string {
	js, _ := json.Marshal(files)
	if files == nil {
		js = []byte("[]")
	}
	safe := strings.ReplaceAll(string(js), "</", "<\\/")
	return strings.Replace(page, "/*STARTUP*/", "window.__STARTUP="+safe+";", 1)
}

var badName = strings.NewReplacer("\\", "_", "/", "_", ":", "_", "*", "_", "?", "_", "\"", "_", "<", "_", ">", "_", "|", "_")

func cleanName(s string) string {
	s = badName.Replace(filepath.Base(strings.TrimSpace(s)))
	if s == "" || s == "." || s == ".." {
		s = "file"
	}
	return s
}

// ---------------------------------------------------------------- сервер
type server struct {
	mu       sync.Mutex
	last     time.Time // последний запрос от окна (кроме «до свидания»)
	bye      time.Time // окно сообщило, что закрывается
	quit     chan struct{}
	quitOnce sync.Once
	startups map[string][]startFile
	host     string
	saved    map[string]bool // папки, куда сохраняли в этот запуск (их можно открыть)
}

func (s *server) touch() { s.mu.Lock(); s.last = time.Now(); s.mu.Unlock() }

func (s *server) addStartup(f []startFile) string {
	b := make([]byte, 8)
	rand.Read(b)
	id := hex.EncodeToString(b)
	s.mu.Lock()
	s.startups[id] = f
	s.mu.Unlock()
	return id
}

func jsonOut(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// только наш адрес (защита от чужих страниц и подмены DNS)
	if r.Host != s.host {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if r.URL.Path != "/api/bye" {
		s.touch()
	}
	switch r.URL.Path {
	case "/api/bye": // окно закрывается (navigator.sendBeacon)
		s.mu.Lock()
		s.bye = time.Now()
		s.mu.Unlock()
		w.WriteHeader(204)
	case "/api/quit": // запущена другая версия программы — освобождаем порт
		if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			http.Error(w, "bad request", 400)
			return
		}
		jsonOut(w, 200, map[string]bool{"ok": true})
		s.quitOnce.Do(func() { close(s.quit) })
	case "/":
		var files []startFile
		if id := r.URL.Query().Get("s"); id != "" {
			s.mu.Lock()
			files = s.startups[id]
			delete(s.startups, id)
			s.mu.Unlock()
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		io.WriteString(w, pageWith(files))
	case "/api/update/check":
		jsonOut(w, 200, checkUpdate())
	case "/api/update/apply":
		if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			http.Error(w, "bad request", 400)
			return
		}
		if err := applyUpdate(); err != nil {
			jsonOut(w, 200, map[string]string{"err": err.Error()})
			return
		}
		jsonOut(w, 200, map[string]bool{"ok": true}) // новая версия сама попросит эту закрыться
	case "/api/update/install":
		if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			http.Error(w, "bad request", 400)
			return
		}
		var req struct{ Ver string }
		json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req)
		if err := applyVersion(req.Ver); err != nil {
			jsonOut(w, 200, map[string]string{"err": err.Error()})
			return
		}
		jsonOut(w, 200, map[string]string{"ok": "1", "ver": strings.TrimPrefix(req.Ver, "v")})
	case "/api/update/prev":
		if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			http.Error(w, "bad request", 400)
			return
		}
		v, err := applyPrev()
		if err != nil {
			jsonOut(w, 200, map[string]string{"err": err.Error()})
			return
		}
		jsonOut(w, 200, map[string]string{"ok": "1", "ver": v})
	case "/api/ping":
		jsonOut(w, 200, map[string]string{"app": "dlina-reza", "ver": version})
	case "/api/startup": // второй запуск exe передаёт свои файлы уже работающему
		if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/json" {
			http.Error(w, "bad request", 400)
			return
		}
		var files []startFile
		if err := json.NewDecoder(io.LimitReader(r.Body, 512<<20)).Decode(&files); err != nil {
			http.Error(w, "bad request", 400)
			return
		}
		jsonOut(w, 200, map[string]string{"id": s.addStartup(files)})
	case "/api/save":
		if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			http.Error(w, "bad request", 400)
			return
		}
		var req struct {
			Folder string `json:"folder"`
			Base   string `json:"base"` // куда (выбранная папка), пусто — рабочий стол
			Name   string `json:"name"` // название новой папки
			Files  []struct {
				Name string `json:"name"`
				Text string `json:"text"`
				B64  string `json:"b64"`
			} `json:"files"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 512<<20)).Decode(&req); err != nil {
			jsonOut(w, 400, map[string]string{"error": "неверные данные"})
			return
		}
		folder := cleanName(req.Folder)
		if req.Folder == "" {
			folder = "Исправленные DXF"
		}
		if folder != "Исправленные DXF" && folder != "Отредактированные PDF" && folder != "Раскрой труб" {
			folder = "Исправленные DXF"
		}
		dir := filepath.Join(desktopDir(), folder, time.Now().Format("2006-01-02 15-04-05"))
		if req.Base != "" || req.Name != "" {
			base := filepath.Clean(req.Base)
			if req.Base == "" {
				base = desktopDir()
			}
			if st, err := os.Stat(base); err != nil || !st.IsDir() {
				jsonOut(w, 400, map[string]string{"error": "папка не найдена: " + base})
				return
			}
			name := strings.TrimSpace(cleanName(req.Name))
			if name == "" || name == "." || name == ".." {
				name = folder + " " + time.Now().Format("2006-01-02 15-04-05")
			}
			dir = filepath.Join(base, name)
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			jsonOut(w, 500, map[string]string{"error": err.Error()})
			return
		}
		for _, f := range req.Files {
			name := cleanName(f.Name)
			low := strings.ToLower(name)
			data := []byte(f.Text)
			if f.B64 != "" {
				b, err := base64.StdEncoding.DecodeString(f.B64)
				if err != nil {
					jsonOut(w, 400, map[string]string{"error": "неверные данные файла"})
					return
				}
				data = b
			}
			// только чертежи, PDF, 3D хлыстов и отчёт
			if !strings.HasSuffix(low, ".dxf") && !strings.HasSuffix(low, ".pdf") && !(folder == "Раскрой труб" && (strings.HasSuffix(low, ".igs") || strings.HasSuffix(low, ".stp") || strings.HasSuffix(low, ".txt"))) {
				name += ".dxf"
			}
			// исходники и уже сохранённое не перезаписываются: при совпадении имени — «имя (2).dxf»
			if err := os.WriteFile(freeName(dir, name), data, 0o644); err != nil {
				jsonOut(w, 500, map[string]string{"error": err.Error()})
				return
			}
		}
		s.mu.Lock()
		if s.saved == nil {
			s.saved = map[string]bool{}
		}
		s.saved[strings.ToLower(filepath.Clean(dir))] = true
		s.mu.Unlock()
		jsonOut(w, 200, map[string]string{"dir": dir})
	case "/api/pickdir":
		if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			http.Error(w, "bad request", 400)
			return
		}
		var req struct{ Start, Prompt string }
		json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req)
		if req.Start == "" {
			req.Start = desktopDir()
		}
		d, err := pickFolder(req.Start, req.Prompt)
		if err != nil {
			jsonOut(w, 200, map[string]string{"error": "не удалось открыть выбор папки: " + err.Error()})
			return
		}
		jsonOut(w, 200, map[string]string{"dir": d})
	case "/api/hist/list", "/api/hist/save", "/api/hist/load", "/api/hist/delete", "/api/hist/open", "/api/hist/dir":
		s.hist(w, r)
	case "/api/openfiles", "/api/file", "/api/findfiles", "/api/proj/export", "/api/proj/import", "/api/savefile":
		s.files(w, r)
	case "/api/open":
		if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			http.Error(w, "bad request", 400)
			return
		}
		var req struct {
			Dir string `json:"dir"`
		}
		json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req)
		// папка из проекта может быть сохранена в прошлый раз или на другом компьютере (общий сервер) — открываем любую существующую
		d := filepath.Clean(req.Dir)
		if !filepath.IsAbs(d) {
			http.Error(w, "forbidden", 403)
			return
		}
		if st, err := os.Stat(d); err != nil || !st.IsDir() {
			http.Error(w, "not found", 404)
			return
		}
		openFolder(d)
		jsonOut(w, 200, map[string]bool{"ok": true})
	default:
		http.NotFound(w, r)
	}
}

func openWindow(link string) bool {
	if br, ok := findBrowser(); ok {
		cmd := exec.Command(br, "--app="+link, "--window-size=1300,900", "--no-first-run", "--no-default-browser-check")
		if err := cmd.Start(); err == nil {
			return true
		}
	}
	return exec.Command("rundll32", "url.dll,FileProtocolHandler", link).Start() == nil
}

// запасной вариант: страница из файла (без сохранения на рабочий стол)
func fileMode(files []startFile) {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.TempDir()
	}
	dir := filepath.Join(base, "DlinaRezaTruby")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		dir = os.TempDir()
	}
	out := filepath.Join(dir, "Длина реза.html")
	if err := os.WriteFile(out, []byte(pageWith(files)), 0o644); err != nil {
		msgBox("Не удалось подготовить окно программы:\n" + err.Error())
		return
	}
	link := (&url.URL{Scheme: "file", Path: "/" + filepath.ToSlash(out)}).String()
	if !openWindow(link) {
		msgBox(fmt.Sprintf("Не удалось открыть окно программы.\nОткройте файл вручную:\n%s", out))
	}
}

func main() {
	cleanupOld()
	go registerProjExt()
	afterUpdate := len(os.Args) > 1 && os.Args[1] == "--after-update"
	var files []startFile
	if !afterUpdate {
		files = readArgs()
	}
	host := fmt.Sprintf("127.0.0.1:%d", port)
	ln, err := net.Listen("tcp", host)
	if err != nil {
		c := &http.Client{Timeout: 5 * time.Second}
		if resp, e := c.Get("http://" + host + "/api/ping"); e == nil {
			var info struct{ App, Ver string }
			json.NewDecoder(resp.Body).Decode(&info)
			resp.Body.Close()
			if info.App == "dlina-reza" {
				if info.Ver != version {
					// работает другая (старая) версия — просим её закрыться и занимаем порт
					if r2, e2 := c.Post("http://"+host+"/api/quit", "application/json", strings.NewReader("{}")); e2 == nil {
						r2.Body.Close()
					}
					for i := 0; i < 40 && err != nil; i++ {
						time.Sleep(150 * time.Millisecond)
						ln, err = net.Listen("tcp", host)
					}
				}
				if err != nil { // та же версия — передаём файлы и открываем ещё одно окно
					link := "http://" + host + "/"
					if len(files) > 0 {
						js, _ := json.Marshal(files)
						if r2, e2 := c.Post("http://"+host+"/api/startup", "application/json", strings.NewReader(string(js))); e2 == nil {
							var o struct{ ID string }
							json.NewDecoder(r2.Body).Decode(&o)
							r2.Body.Close()
							link += "?s=" + o.ID
						}
					}
					openWindow(link)
					return
				}
			}
		}
		if err != nil {
			fileMode(files)
			return
		}
	}
	s := &server{last: time.Now(), startups: map[string][]startFile{}, host: host, quit: make(chan struct{})}
	link := "http://" + host + "/"
	if len(files) > 0 {
		link += "?s=" + s.addStartup(files)
	}
	srv := &http.Server{Handler: s}
	go srv.Serve(ln)
	if afterUpdate { // окно уже открыто: страница сама перезагрузится, увидев новую версию
		s.touch()
	} else if !openWindow(link) {
		msgBox("Не удалось открыть окно программы.\nОткройте в браузере адрес:\n" + link)
	}
	// работаем, пока открыто окно: страница отмечается каждые 5 с, при закрытии шлёт «до свидания»
	started := time.Now()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-s.quit:
			time.Sleep(200 * time.Millisecond)
			srv.Close()
			return
		case <-tick.C:
		}
		s.mu.Lock()
		last, bye := s.last, s.bye
		s.mu.Unlock()
		// окно закрыли: «до свидания» было, а новых запросов после него нет (перезагрузка страницы их даёт)
		if !bye.IsZero() && last.Before(bye) && time.Since(bye) > 4*time.Second {
			srv.Close()
			return
		}
		// окно пропало без «до свидания» (свёрнутое окно отмечается не реже раза в минуту)
		if time.Since(started) > time.Minute && time.Since(last) > 150*time.Second {
			srv.Close()
			return
		}
	}
}
