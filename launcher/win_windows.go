//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

func msgBox(text string) {
	u32 := syscall.NewLazyDLL("user32.dll")
	p := u32.NewProc("MessageBoxW")
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(title)
	p.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), 0x40)
}

// папка «Рабочий стол» (с учётом переноса в OneDrive)
func desktopDir() string {
	shell32 := syscall.NewLazyDLL("shell32.dll")
	proc := shell32.NewProc("SHGetFolderPathW")
	buf := make([]uint16, 1024)
	// CSIDL_DESKTOPDIRECTORY = 0x10 (учитывает перенос рабочего стола, например в OneDrive)
	if r, _, _ := proc.Call(0, 0x10, 0, 0, uintptr(unsafe.Pointer(&buf[0]))); r == 0 {
		if d := syscall.UTF16ToString(buf); d != "" {
			return d
		}
	}
	if h, err := os.UserHomeDir(); err == nil {
		return filepath.Join(h, "Desktop")
	}
	return os.TempDir()
}

// папка «Документы» (CSIDL_PERSONAL = 0x05)
func documentsDir() string {
	shell32 := syscall.NewLazyDLL("shell32.dll")
	proc := shell32.NewProc("SHGetFolderPathW")
	buf := make([]uint16, 1024)
	if r, _, _ := proc.Call(0, 0x05, 0, 0, uintptr(unsafe.Pointer(&buf[0]))); r == 0 {
		if d := syscall.UTF16ToString(buf); d != "" {
			return d
		}
	}
	if h, err := os.UserHomeDir(); err == nil {
		return filepath.Join(h, "Documents")
	}
	return os.TempDir()
}

// окно выбора папки Windows (в том числе сетевой); "" — отменили
func pickFolder(start, prompt string) (string, error) {
	q := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	script := "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
		"Add-Type -AssemblyName System.Windows.Forms;" +
		"$f=New-Object System.Windows.Forms.FolderBrowserDialog;" +
		"$f.Description=" + q(prompt) + ";$f.ShowNewFolderButton=$true;" +
		"if(Test-Path -LiteralPath " + q(start) + "){$f.SelectedPath=" + q(start) + "};" +
		"$o=New-Object System.Windows.Forms.Form -Property @{TopMost=$true;ShowInTaskbar=$false};" +
		"if($f.ShowDialog($o) -eq 'OK'){Write-Output $f.SelectedPath}"
	cmd := exec.Command("powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(strings.TrimPrefix(string(out), "\ufeff")), nil
}

func openFolder(d string) { exec.Command("explorer.exe", d).Start() }

func runPS(script string) (string, error) {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8;"+script)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	out, err := cmd.Output()
	return strings.TrimPrefix(string(out), "\ufeff"), err
}

func psq(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// окно «Открыть» Windows: полные пути выбранных файлов
func pickFiles(start, filter string, multi bool) ([]string, error) {
	m := "$false"
	if multi {
		m = "$true"
	}
	out, err := runPS("Add-Type -AssemblyName System.Windows.Forms;" +
		"$d=New-Object System.Windows.Forms.OpenFileDialog;$d.Filter=" + psq(filter) + ";$d.Multiselect=" + m + ";$d.Title='Раскладчик — открыть';" +
		"if(" + psq(start) + " -ne '' -and (Test-Path -LiteralPath " + psq(start) + ")){$d.InitialDirectory=" + psq(start) + "};" +
		"$o=New-Object System.Windows.Forms.Form -Property @{TopMost=$true;ShowInTaskbar=$false};" +
		"if($d.ShowDialog($o) -eq 'OK'){$d.FileNames | ForEach-Object { Write-Output $_ }}")
	if err != nil {
		return nil, err
	}
	var res []string
	for _, l := range strings.Split(out, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			res = append(res, l)
		}
	}
	return res, nil
}

// окно «Сохранить как»
func pickSaveFile(name, filter string) (string, error) {
	out, err := runPS("Add-Type -AssemblyName System.Windows.Forms;" +
		"$d=New-Object System.Windows.Forms.SaveFileDialog;$d.Filter=" + psq(filter) + ";$d.FileName=" + psq(name) + ";$d.OverwritePrompt=$true;$d.Title='Раскладчик — сохранить проект';" +
		"$o=New-Object System.Windows.Forms.Form -Property @{TopMost=$true;ShowInTaskbar=$false};" +
		"if($d.ShowDialog($o) -eq 'OK'){Write-Output $d.FileName}")
	return strings.TrimSpace(out), err
}

// настройки программы: %APPDATA%\Раскладчик\config.json
func configDir() string {
	if d := os.Getenv("APPDATA"); d != "" {
		return filepath.Join(d, "Раскладчик")
	}
	return filepath.Join(documentsDir(), "Раскладчик")
}
