package main

// Файлы по путям: окно «Открыть» Windows, чтение чертежа по запомненному пути, поиск перетащенных файлов в папке,
// проект в файл (.dsmet) и из файла, один файл через «Сохранить как».

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// проект одним файлом; .raskl — старое название, читается по-прежнему
const projExt = ".dsmet"

var drawingExt = map[string]bool{".x_t": true, ".xmt_txt": true, ".igs": true, ".iges": true, ".stp": true, ".step": true, ".pdf": true, ".tif": true, ".tiff": true, ".dxf": true, ".jpg": true, ".jpeg": true, ".png": true, ".bmp": true, ".raskl": true, ".dsmet": true}

func (s *server) files(w http.ResponseWriter, r *http.Request) {
	isPost := r.Method == http.MethodPost && strings.HasPrefix(r.Header.Get("Content-Type"), "application/json")
	switch r.URL.Path {
	case "/api/openfiles": // окно «Открыть» (несколько файлов) — возвращает полные пути
		if !isPost {
			http.Error(w, "bad request", 400)
			return
		}
		var req struct{ Kind, Start string }
		json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req)
		filter := "Чертежи|*.x_t;*.xmt_txt;*.igs;*.iges;*.stp;*.step;*.pdf;*.tif;*.tiff|Все файлы|*.*"
		switch req.Kind {
		case "dxf":
			filter = "Чертежи DXF|*.dxf|Все файлы|*.*"
		case "pdf":
			filter = "PDF и сканы|*.pdf;*.tif;*.tiff;*.jpg;*.jpeg;*.png;*.bmp|Все файлы|*.*"
		case "sheet":
			filter = "DXF и эскизы|*.dxf;*.pdf;*.tif;*.tiff;*.jpg;*.jpeg;*.png;*.bmp|Чертежи DXF|*.dxf|Все файлы|*.*"
		case "proj", "raskl":
			filter = "Проект Раскладчика|*.dsmet;*.raskl|Все файлы|*.*"
		}
		paths, err := pickFiles(req.Start, filter, req.Kind != "raskl" && req.Kind != "proj")
		if err != nil {
			jsonOut(w, 200, map[string]string{"error": "не удалось открыть окно выбора: " + err.Error()})
			return
		}
		jsonOut(w, 200, map[string]any{"paths": paths})
	case "/api/file": // прочитать чертёж по пути (только чертежи и сканы)
		p := filepath.Clean(r.URL.Query().Get("path"))
		if !filepath.IsAbs(p) || !drawingExt[strings.ToLower(filepath.Ext(p))] {
			http.Error(w, "forbidden", 403)
			return
		}
		b, err := os.ReadFile(p)
		if err != nil {
			http.Error(w, "Файл не найден: "+p, 404)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(b)
	case "/api/locate": // перетащили файлы — сами ищем, откуда: открытые окна Проводника, рабочий стол, загрузки, документы, прошлые папки
		if !isPost {
			http.Error(w, "bad request", 400)
			return
		}
		var req struct {
			Dirs  []string
			Files []struct {
				Name string
				Size int64
			}
		}
		json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&req)
		want := map[string]int64{}
		for _, f := range req.Files {
			want[strings.ToLower(f.Name)] = f.Size
		}
		found := map[string]string{}
		seen := map[string]bool{}
		roots := append(explorerDirs(), req.Dirs...)
		roots = append(roots, desktopDir(), downloadsDir(), documentsDir())
		for i, root := range roots {
			if root == "" || len(found) == len(want) {
				continue
			}
			root = filepath.Clean(root)
			if seen[strings.ToLower(root)] {
				continue
			}
			seen[strings.ToLower(root)] = true
			depth := 2
			if i < len(roots)-3 {
				depth = 3 // окна Проводника и прошлые папки — поглубже
			}
			findIn(root, depth, want, found, 30000)
		}
		jsonOut(w, 200, map[string]any{"found": found})
	case "/api/findfiles": // где лежат перетащенные файлы: ищем по имени и размеру в выбранной папке (3 уровня вглубь)
		if !isPost {
			http.Error(w, "bad request", 400)
			return
		}
		var req struct {
			Dir   string
			Files []struct {
				Name string
				Size int64
			}
		}
		json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&req)
		want := map[string]int64{}
		for _, f := range req.Files {
			want[strings.ToLower(f.Name)] = f.Size
		}
		found := map[string]string{}
		root := filepath.Clean(req.Dir)
		n := 0
		filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			n++
			if n > 50000 || len(found) == len(want) {
				return filepath.SkipAll
			}
			if d.IsDir() {
				if rel, _ := filepath.Rel(root, p); strings.Count(rel, string(os.PathSeparator)) >= 3 {
					return filepath.SkipDir
				}
				return nil
			}
			k := strings.ToLower(d.Name())
			if sz, ok := want[k]; ok {
				if _, done := found[k]; !done {
					if fi, e := d.Info(); e == nil && (sz <= 0 || fi.Size() == sz) {
						found[k] = p
					}
				}
			}
			return nil
		})
		jsonOut(w, 200, map[string]any{"found": found})
	case "/api/proj/export": // проект в файл .raskl: окно «Сохранить как»
		if !isPost {
			http.Error(w, "bad request", 400)
			return
		}
		var req struct {
			Name string          `json:"name"`
			Data json.RawMessage `json:"data"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 512<<20)).Decode(&req); err != nil || !json.Valid(req.Data) {
			jsonOut(w, 400, map[string]string{"error": "неверные данные"})
			return
		}
		name := cleanName(req.Name)
		if name == "" || name == "." {
			name = "Проект"
		}
		p, err := pickSaveFile(name+projExt, "Проект Раскладчика|*"+projExt, "Раскладчик — сохранить проект")
		if err != nil {
			jsonOut(w, 200, map[string]string{"error": "не удалось открыть окно: " + err.Error()})
			return
		}
		if p == "" {
			jsonOut(w, 200, map[string]string{})
			return
		}
		if !strings.HasSuffix(strings.ToLower(p), projExt) {
			p += projExt
		}
		if err := os.WriteFile(p, req.Data, 0o644); err != nil {
			jsonOut(w, 200, map[string]string{"error": err.Error()})
			return
		}
		jsonOut(w, 200, map[string]string{"path": p})
	case "/api/savefile": // один файл через окно «Сохранить как» (DXF из редактора)
		if !isPost {
			http.Error(w, "bad request", 400)
			return
		}
		var req struct{ Name, B64 string }
		if err := json.NewDecoder(io.LimitReader(r.Body, 256<<20)).Decode(&req); err != nil {
			jsonOut(w, 400, map[string]string{"error": "неверные данные"})
			return
		}
		data, err := base64.StdEncoding.DecodeString(req.B64)
		if err != nil {
			jsonOut(w, 400, map[string]string{"error": "неверные данные"})
			return
		}
		name := cleanName(req.Name)
		if strings.ToLower(filepath.Ext(name)) != ".dxf" {
			name += ".dxf"
		}
		p, err := pickSaveFile(name, "Чертёж DXF|*.dxf", "Раскладчик — сохранить DXF")
		if err != nil {
			jsonOut(w, 200, map[string]string{"error": "не удалось открыть окно: " + err.Error()})
			return
		}
		if p == "" {
			jsonOut(w, 200, map[string]string{})
			return
		}
		if strings.ToLower(filepath.Ext(p)) != ".dxf" {
			p += ".dxf"
		}
		if err := os.WriteFile(p, data, 0o644); err != nil {
			jsonOut(w, 200, map[string]string{"error": err.Error()})
			return
		}
		jsonOut(w, 200, map[string]string{"path": p})
	case "/api/proj/import": // прочитать проект из файла .raskl (путь из окна «Открыть» или из запуска)
		p := filepath.Clean(r.URL.Query().Get("path"))
		if e := strings.ToLower(filepath.Ext(p)); !filepath.IsAbs(p) || (e != projExt && e != ".raskl") {
			http.Error(w, "forbidden", 403)
			return
		}
		b, err := os.ReadFile(p)
		if err != nil || !json.Valid(b) {
			http.Error(w, "не удалось прочитать проект", 404)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(b)
	default:
		http.NotFound(w, r)
	}
}

// поиск файлов по имени (и размеру, если известен) в папке не глубже depth
func findIn(root string, depth int, want map[string]int64, found map[string]string, limit int) {
	n := 0
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		n++
		if n > limit || len(found) == len(want) {
			return filepath.SkipAll
		}
		if d.IsDir() {
			if rel, _ := filepath.Rel(root, p); rel != "." && strings.Count(rel, string(os.PathSeparator)) >= depth-1 {
				return filepath.SkipDir
			}
			return nil
		}
		k := strings.ToLower(d.Name())
		if sz, ok := want[k]; ok {
			if _, done := found[k]; !done {
				if fi, e := d.Info(); e == nil && (sz <= 0 || fi.Size() == sz) {
					found[k] = p
				}
			}
		}
		return nil
	})
}
