package main

// STEP → IGES через Mayo (открытый конвертер на ядре Open CASCADE, github.com/fougue/mayo).
// Скачивается один раз при первом раскрое со STEP в %LOCALAPPDATA%\Раскладчик\mayo, архив сверяется по SHA-256.

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	mayoVer = "0.10.0"
	mayoURL = "https://github.com/fougue/mayo/releases/download/v0.10.0/Mayo-0.10.0-win64-binaries.zip"
	mayoSHA = "4cd2df02e0d5b113873515b0e222e9944629d432fe731537204a119c3b6d74b2"
)

var mayoMu sync.Mutex // одна установка и один перевод за раз

func mayoRoot() string {
	if d := os.Getenv("MAYO_DIR"); d != "" {
		return d
	}
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "Раскладчик", "mayo")
}

// путь к mayo-conv, если уже установлен
func mayoExe() string {
	if p := os.Getenv("MAYO_EXE"); p != "" {
		return p
	}
	name := "mayo-conv.exe"
	cand := []string{filepath.Join(mayoRoot(), "Mayo-"+mayoVer+"-win64-binaries", name), filepath.Join(mayoRoot(), name)}
	for _, c := range cand {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c
		}
	}
	return ""
}

func mayoInstall() error {
	if mayoExe() != "" {
		return nil
	}
	root := mayoRoot()
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	zipPath := filepath.Join(root, "mayo.zip")
	c := &http.Client{Timeout: 10 * time.Minute}
	req, _ := http.NewRequest("GET", mayoURL, nil)
	req.Header.Set("User-Agent", "Raskladchik")
	resp, err := c.Do(req)
	if err != nil {
		return errors.New("нет связи с GitHub — не скачался переводчик STEP")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("GitHub ответил %d при скачивании переводчика STEP", resp.StatusCode)
	}
	f, err := os.Create(zipPath)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, 200<<20))
	f.Close()
	if err != nil {
		os.Remove(zipPath)
		return errors.New("переводчик STEP скачался не полностью")
	}
	if hex.EncodeToString(h.Sum(nil)) != mayoSHA {
		os.Remove(zipPath)
		return errors.New("скачанный переводчик STEP не совпал по контрольной сумме — не ставлю")
	}
	if err := unzipTo(zipPath, root); err != nil {
		return errors.New("не распаковался переводчик STEP: " + err.Error())
	}
	os.Remove(zipPath)
	if mayoExe() == "" {
		return errors.New("в архиве переводчика нет mayo-conv.exe")
	}
	return nil
}

func unzipTo(src, dst string) error {
	z, err := zip.OpenReader(src)
	if err != nil {
		return err
	}
	defer z.Close()
	base, _ := filepath.Abs(dst)
	for _, f := range z.File {
		p := filepath.Join(base, filepath.FromSlash(f.Name))
		if !strings.HasPrefix(p, base+string(os.PathSeparator)) {
			continue // путь за пределы папки — пропускаем
		}
		if f.FileInfo().IsDir() {
			os.MkdirAll(p, 0o755)
			continue
		}
		os.MkdirAll(filepath.Dir(p), 0o755)
		r, err := f.Open()
		if err != nil {
			return err
		}
		w, err := os.Create(p)
		if err != nil {
			r.Close()
			return err
		}
		_, err = io.Copy(w, r)
		w.Close()
		r.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// один STEP (байты) → IGES (байты)
func mayoConvert(step []byte) ([]byte, error) {
	exe := mayoExe()
	if exe == "" {
		return nil, errors.New("переводчик STEP не установлен")
	}
	dir, err := os.MkdirTemp("", "raskl-step")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	in, out := filepath.Join(dir, "part.step"), filepath.Join(dir, "part.igs")
	if err := os.WriteFile(in, step, 0o644); err != nil {
		return nil, err
	}
	cmd := exec.Command(exe, "--no-progress", in, "-e", out)
	cmd.Dir = filepath.Dir(exe)
	hideWindow(cmd)
	done := make(chan error, 1)
	var log strings.Builder
	cmd.Stdout, cmd.Stderr = &log, &log
	if err := cmd.Start(); err != nil {
		return nil, errors.New("не запустился переводчик STEP: " + err.Error())
	}
	go func() { done <- cmd.Wait() }()
	select {
	case err = <-done:
	case <-time.After(3 * time.Minute):
		cmd.Process.Kill()
		return nil, errors.New("переводчик STEP завис")
	}
	b, rerr := os.ReadFile(out)
	if rerr != nil || len(b) == 0 {
		msg := strings.TrimSpace(log.String())
		if len(msg) > 300 {
			msg = msg[len(msg)-300:]
		}
		if err != nil {
			msg = err.Error() + " " + msg
		}
		return nil, errors.New("переводчик STEP не сделал IGES: " + msg)
	}
	return b, nil
}

func (s *server) mayoAPI(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/mayo/check":
		jsonOut(w, 200, map[string]any{"ok": mayoExe() != ""})
	case "/api/mayo/install":
		if r.Method != http.MethodPost {
			http.Error(w, "bad request", 400)
			return
		}
		mayoMu.Lock()
		err := mayoInstall()
		mayoMu.Unlock()
		if err != nil {
			jsonOut(w, 200, map[string]any{"error": err.Error()})
			return
		}
		jsonOut(w, 200, map[string]any{"ok": true})
	case "/api/mayo/convert": // тело — STEP, ответ — IGES (или JSON с ошибкой)
		if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/octet-stream" {
			http.Error(w, "bad request", 400)
			return
		}
		b, err := io.ReadAll(io.LimitReader(r.Body, 500<<20))
		if err != nil {
			jsonOut(w, 200, map[string]any{"error": err.Error()})
			return
		}
		mayoMu.Lock()
		out, err := mayoConvert(b)
		mayoMu.Unlock()
		if err != nil {
			jsonOut(w, 200, map[string]any{"error": err.Error()})
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(out)
	}
}
