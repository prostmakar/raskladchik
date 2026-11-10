//go:build !windows

// Заглушки для сборки и проверки не под Windows.
package main

import (
	"fmt"
	"os"
	"path/filepath"
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
