package main

// Перевод файлов раскроя в .zzx через установленную TubesT Lite: программа открывает IGES из командной строки,
// дальше «Сохранить как» (кнопка 2 на панели быстрого доступа) — .zzx рядом с исходником. Файлы по одному, в фоне.

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

type tubestJob struct {
	mu      sync.Mutex
	Running bool     `json:"running"`
	Total   int      `json:"total"`
	Done    int      `json:"done"`
	Cur     string   `json:"cur"`
	Made    []string `json:"made"`
	Errs    []string `json:"errs"`
	Stop    bool     `json:"stop"`
	Dir     string   `json:"dir"`
}

var tjob tubestJob

func (j *tubestJob) snapshot() map[string]any {
	j.mu.Lock()
	defer j.mu.Unlock()
	return map[string]any{"running": j.Running, "total": j.Total, "done": j.Done, "cur": j.Cur, "made": append([]string{}, j.Made...), "errs": append([]string{}, j.Errs...), "dir": j.Dir}
}

func (s *server) tubestAPI(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/tubest/check": // установлена ли TubesT
		exe := tubestExe()
		jsonOut(w, 200, map[string]any{"exe": exe, "ok": exe != ""})
	case "/api/tubest/status":
		jsonOut(w, 200, tjob.snapshot())
	case "/api/tubest/stop":
		tjob.mu.Lock()
		tjob.Stop = true
		tjob.mu.Unlock()
		jsonOut(w, 200, map[string]bool{"ok": true})
	case "/api/tubest/start": // {dir}: все .igs в папке, у которых ещё нет .zzx
		if r.Method != http.MethodPost {
			http.Error(w, "bad request", 400)
			return
		}
		var req struct{ Dir string }
		json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req)
		dir := filepath.Clean(req.Dir)
		if st, err := os.Stat(dir); err != nil || !st.IsDir() || !filepath.IsAbs(dir) {
			jsonOut(w, 200, map[string]string{"error": "папка не найдена: " + req.Dir})
			return
		}
		exe := tubestExe()
		if exe == "" {
			jsonOut(w, 200, map[string]string{"error": "TubesT не найдена на этом компьютере"})
			return
		}
		if tubestRunning() {
			jsonOut(w, 200, map[string]string{"error": "Закройте TubesT — перевод работает в своём окне программы"})
			return
		}
		ents, _ := os.ReadDir(dir)
		var files []string
		for _, e := range ents {
			n := e.Name()
			if e.IsDir() || !strings.EqualFold(filepath.Ext(n), ".igs") {
				continue
			}
			if _, err := os.Stat(filepath.Join(dir, strings.TrimSuffix(n, filepath.Ext(n))+".zzx")); err == nil {
				continue // уже переведён — не трогаем
			}
			files = append(files, filepath.Join(dir, n))
		}
		sort.Strings(files)
		tjob.mu.Lock()
		if tjob.Running {
			tjob.mu.Unlock()
			jsonOut(w, 200, map[string]string{"error": "перевод уже идёт"})
			return
		}
		tjob.Running, tjob.Total, tjob.Done, tjob.Cur, tjob.Made, tjob.Errs, tjob.Stop, tjob.Dir = true, len(files), 0, "", nil, nil, false, dir
		tjob.mu.Unlock()
		go func() {
			for _, f := range files {
				tjob.mu.Lock()
				stop := tjob.Stop
				tjob.Cur = filepath.Base(f)
				tjob.mu.Unlock()
				if stop {
					break
				}
				out, err := tubestConvert(exe, f)
				tjob.mu.Lock()
				tjob.Done++
				if err != nil {
					tjob.Errs = append(tjob.Errs, filepath.Base(f)+": "+err.Error())
				} else if strings.TrimSpace(out) != "" {
					tjob.Made = append(tjob.Made, strings.TrimSpace(out))
				}
				tjob.mu.Unlock()
			}
			tjob.mu.Lock()
			tjob.Running, tjob.Cur = false, ""
			tjob.mu.Unlock()
		}()
		jsonOut(w, 200, map[string]any{"ok": true, "total": len(files)})
	default:
		http.NotFound(w, r)
	}
}
