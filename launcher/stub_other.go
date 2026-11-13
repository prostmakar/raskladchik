//go:build !windows

// Заглушки для сборки и проверки не под Windows.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func msgBox(text string) { fmt.Println(text) }

func desktopDir() string {
	if d := os.Getenv("DESKTOP_DIR"); d != "" {
		return d
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, "Desktop")
}

func documentsDir() string {
	if d := os.Getenv("DOCUMENTS_DIR"); d != "" {
		return d
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, "Documents")
}

func pickFolder(start, prompt string) (string, error) { return os.Getenv("PICK_DIR"), nil }

func openFolder(d string) {}

func pickFiles(start, filter string, multi bool) ([]string, error) {
	if p := os.Getenv("PICK_FILES"); p != "" {
		return strings.Split(p, "|"), nil
	}
	return nil, nil
}

func registerProjExt() {}

func pickSaveFile(name, filter, title string) (string, error) {
	if d := os.Getenv("PICK_SAVE_DIR"); d != "" {
		return filepath.Join(d, name), nil
	}
	return "", nil
}

func configDir() string { return filepath.Join(documentsDir(), ".raskl-config") }

// TubesT для проверки не под Windows: TUBEST_FAKE=1 — «переводит» igs в zzx копированием
func tubestExe() string {
	if os.Getenv("TUBEST_FAKE") != "" {
		return "fake"
	}
	return ""
}
func tubestRunning() bool { return false }
func tubestConvert(exe, src string) (string, error) {
	dst := strings.TrimSuffix(src, filepath.Ext(src)) + ".zzx"
	b, err := os.ReadFile(src)
	if err != nil {
		return "", err
	}
	if len(b) > 100 {
		b = b[:100]
	}
	return filepath.Base(dst), os.WriteFile(dst, b, 0o644)
}

func explorerDirs() []string {
	if d := os.Getenv("EXPLORER_DIR"); d != "" {
		return []string{d}
	}
	return nil
}
func downloadsDir() string { return os.Getenv("DOWNLOADS_DIR") }
func tubestCount() int     { return 0 }

func hideWindow(c *exec.Cmd) {}
