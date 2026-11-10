//go:build !windows

// Заглушки для сборки и проверки не под Windows.
package main

import (
	"fmt"
	"os"
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

func pickSaveFile(name, filter string) (string, error) {
	if d := os.Getenv("PICK_SAVE_DIR"); d != "" {
		return filepath.Join(d, name), nil
	}
	return "", nil
}

func configDir() string { return filepath.Join(documentsDir(), ".raskl-config") }
