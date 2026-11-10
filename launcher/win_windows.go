//go:build windows

package main

import (
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unicode/utf16"
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
	script := "Add-Type -AssemblyName System.Windows.Forms;" +
		"$f=New-Object System.Windows.Forms.FolderBrowserDialog;" +
		"$f.Description=" + q(prompt) + ";$f.ShowNewFolderButton=$true;" +
		"if(Test-Path -LiteralPath " + q(start) + "){$f.SelectedPath=" + q(start) + "};" +
		ownerPS +
		"if($f.ShowDialog($o) -eq 'OK'){Write-Output $f.SelectedPath};$o.Close()"
	out, err := runPS(script)
	return strings.TrimSpace(out), err
}

func openFolder(d string) { exec.Command("explorer.exe", d).Start() }

func runPS(script string) (string, error) {
	// скрипт передаётся в base64 (UTF-16LE): кавычки и кириллица в путях не ломают командную строку
	full := "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" + script
	u := utf16.Encode([]rune(full))
	b := make([]byte, len(u)*2)
	for i, c := range u {
		b[2*i], b[2*i+1] = byte(c), byte(c>>8)
	}
	cmd := exec.Command("powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", base64.StdEncoding.EncodeToString(b))
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
		ownerPS +
		"if($d.ShowDialog($o) -eq 'OK'){$d.FileNames | ForEach-Object { Write-Output $_ }};$o.Close()")
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
		ownerPS +
		"if($d.ShowDialog($o) -eq 'OK'){Write-Output $d.FileName};$o.Close()")
	return strings.TrimSpace(out), err
}

// настройки программы: %APPDATA%\Раскладчик\config.json
func configDir() string {
	if d := os.Getenv("APPDATA"); d != "" {
		return filepath.Join(d, "Раскладчик")
	}
	return filepath.Join(documentsDir(), "Раскладчик")
}

// невидимое окно-владелец поверх всех и вывод на передний план: иначе окно выбора открывается за окном программы
const ownerPS = "$o=New-Object System.Windows.Forms.Form -Property @{TopMost=$true;ShowInTaskbar=$false;Opacity=0;FormBorderStyle='None';StartPosition='CenterScreen';Width=1;Height=1};$o.Show();" +
	"Add-Type -Namespace RK -Name FG -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);';" +
	"[RK.FG]::keybd_event(0x12,0,0,[UIntPtr]::Zero);[RK.FG]::keybd_event(0x12,0,2,[UIntPtr]::Zero);[void][RK.FG]::SetForegroundWindow($o.Handle);$o.Activate();$o.TopMost=$true;"
