package main

// История проектов: Документы\Раскладчик\История\<id>.json (данные) и <id>.meta.json (карточка для списка).

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

var idRx = regexp.MustCompile(`^[A-Za-z0-9_-]{4,64}$`)

func histDir() string { return filepath.Join(documentsDir(), "Раскладчик", "История") }

func (s *server) hist(w http.ResponseWriter, r *http.Request) {
	dir := histDir()
	post := func() bool {
		if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			http.Error(w, "bad request", 400)
			return false
		}
		return true
	}
	switch r.URL.Path {
	case "/api/hist/list":
		out := []json.RawMessage{}
		ents, _ := os.ReadDir(dir)
		type item struct {
			t   time.Time
			raw json.RawMessage
		}
		var items []item
		for _, e := range ents {
			if !strings.HasSuffix(e.Name(), ".meta.json") {
				continue
			}
			b, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil || !json.Valid(b) {
				continue
			}
			fi, _ := e.Info()
			items = append(items, item{fi.ModTime(), b})
		}
		sort.Slice(items, func(i, j int) bool { return items[i].t.After(items[j].t) })
		for _, it := range items {
			out = append(out, it.raw)
		}
		jsonOut(w, 200, map[string]any{"dir": dir, "items": out})
	case "/api/hist/save":
		if !post() {
			return
		}
		var req struct {
			ID   string          `json:"id"`
			Meta json.RawMessage `json:"meta"`
			Data json.RawMessage `json:"data"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 512<<20)).Decode(&req); err != nil || !idRx.MatchString(req.ID) {
			jsonOut(w, 400, map[string]string{"error": "неверные данные"})
			return
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			jsonOut(w, 500, map[string]string{"error": err.Error()})
			return
		}
		if len(req.Data) > 0 {
			if err := writeAtomic(filepath.Join(dir, req.ID+".json"), req.Data); err != nil {
				jsonOut(w, 500, map[string]string{"error": err.Error()})
				return
			}
		}
		if err := writeAtomic(filepath.Join(dir, req.ID+".meta.json"), req.Meta); err != nil {
			jsonOut(w, 500, map[string]string{"error": err.Error()})
			return
		}
		jsonOut(w, 200, map[string]bool{"ok": true})
	case "/api/hist/load":
		id := r.URL.Query().Get("id")
		if !idRx.MatchString(id) {
			http.Error(w, "bad id", 400)
			return
		}
		b, err := os.ReadFile(filepath.Join(dir, id+".json"))
		if err != nil {
			http.Error(w, "not found", 404)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(b)
	case "/api/hist/delete":
		if !post() {
			return
		}
		var req struct{ ID string }
		json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req)
		if !idRx.MatchString(req.ID) {
			http.Error(w, "bad id", 400)
			return
		}
		os.Remove(filepath.Join(dir, req.ID+".json"))
		os.Remove(filepath.Join(dir, req.ID+".meta.json"))
		jsonOut(w, 200, map[string]bool{"ok": true})
	case "/api/hist/open":
		os.MkdirAll(dir, 0o755)
		openFolder(dir)
		jsonOut(w, 200, map[string]bool{"ok": true})
	default:
		http.NotFound(w, r)
	}
}

func writeAtomic(path string, b []byte) error {
	if len(b) == 0 || !json.Valid(b) {
		return errors.New("пустые данные")
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// свободное имя файла: «имя.dxf», «имя (2).dxf», … — существующие файлы не перезаписываются
func freeName(dir, name string) string {
	p := filepath.Join(dir, name)
	if _, err := os.Stat(p); os.IsNotExist(err) {
		return p
	}
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i := 2; i < 10000; i++ {
		p = filepath.Join(dir, base+" ("+itoa(i)+")"+ext)
		if _, err := os.Stat(p); os.IsNotExist(err) {
			return p
		}
	}
	return p
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}
