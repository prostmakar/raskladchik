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
func pickSaveFile(name, filter, title string) (string, error) {
	out, err := runPS("Add-Type -AssemblyName System.Windows.Forms;" +
		"$d=New-Object System.Windows.Forms.SaveFileDialog;$d.Filter=" + psq(filter) + ";$d.FileName=" + psq(name) + ";$d.OverwritePrompt=$true;$d.Title=" + psq(title) + ";" +
		ownerPS +
		"if($d.ShowDialog($o) -eq 'OK'){Write-Output $d.FileName};$o.Close()")
	return strings.TrimSpace(out), err
}

// двойной щелчок по .dsmet открывает проект: запись в реестре текущего пользователя (прав администратора не нужно).
// Пишется при каждом запуске, если exe переехал — путь обновится сам.
func registerProjExt() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	const cls = `HKCU\Software\Classes\Raskladchik.Project`
	want := `"` + exe + `" "%1"`
	reg := func(args ...string) ([]byte, error) {
		c := exec.Command("reg", args...)
		c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		return c.Output()
	}
	if out, err := reg("query", cls+`\shell\open\command`, "/ve"); err == nil && strings.Contains(string(out), exe) {
		if out2, err2 := reg("query", `HKCU\Software\Classes\.dsmet`, "/ve"); err2 == nil && strings.Contains(string(out2), "Raskladchik.Project") {
			return
		}
	}
	reg("add", `HKCU\Software\Classes\.dsmet`, "/ve", "/d", "Raskladchik.Project", "/f")
	reg("add", cls, "/ve", "/d", "Проект Раскладчика", "/f")
	reg("add", cls+`\DefaultIcon`, "/ve", "/d", `"`+exe+`",0`, "/f")
	reg("add", cls+`\shell\open\command`, "/ve", "/d", want, "/f")
	// сказать проводнику, что связи файлов изменились (SHCNE_ASSOCCHANGED)
	syscall.NewLazyDLL("shell32.dll").NewProc("SHChangeNotify").Call(0x08000000, 0, 0, 0)
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

// ---------------------------------------------------------------- TubesT Lite
func tubestExe() string {
	cands := []string{}
	for _, pf := range []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles")} {
		if pf == "" {
			continue
		}
		cands = append(cands, filepath.Join(pf, "Friendess", "TubesTLite", "TubesTLite.exe"))
		if m, _ := filepath.Glob(filepath.Join(pf, "Friendess", "*", "TubesT*.exe")); len(m) > 0 {
			cands = append(cands, m...)
		}
	}
	for _, c := range cands {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c
		}
	}
	return ""
}

func tubestRunning() bool {
	out, _ := runPS("@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'TubesT*' }).Count")
	return strings.TrimSpace(out) != "" && strings.TrimSpace(out) != "0"
}

// один IGES → .zzx рядом. TubesT открывает файл из командной строки, «Сохранить как» — Alt, 2, Enter,
// в окне сохранения — полный путь через буфер обмена (кириллица и спецсимволы в SendKeys ломаются), потом закрыть.
const tubestPS = `
$ErrorActionPreference='Stop'
trap { Write-Output ('ERR:' + $_.Exception.Message); exit 1 }
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public class TW {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EP p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint fl, UIntPtr ex);
  public static List<string[]> Wins(uint pid) {
    var r = new List<string[]>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) {
      var t = new StringBuilder(512); GetWindowText(h, t, 512); var c = new StringBuilder(256); GetClassName(h, c, 256);
      r.Add(new string[] { h.ToInt64().ToString(), t.ToString(), c.ToString() }); } return true; }, IntPtr.Zero);
    return r;
  }
  public static void Key(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); keybd_event(vk, 0, 2, UIntPtr.Zero); }
  public static bool Front(IntPtr h) { ShowWindow(h, 9); keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); SetForegroundWindow(h); return GetForegroundWindow() == h; }
}
"@
$src = __SRC__; $exe = __EXE__
$dst = [IO.Path]::ChangeExtension($src, '.zzx')
$name = [IO.Path]::GetFileName($src)
$sh = New-Object -ComObject WScript.Shell
$clip = $null; try { $clip = Get-Clipboard -Raw } catch {}
$p = Start-Process -FilePath $exe -ArgumentList ('"' + $src + '"') -PassThru
try {
  $deadline = (Get-Date).AddMinutes(20)
  function Win($pred) { foreach ($w in [TW]::Wins([uint32]$p.Id)) { if (& $pred $w) { return $w } } return $null }
  function Dlg { Win { param($w) $w[2] -eq '#32770' -or $w[2] -eq 'TMessageForm' } }
  # главное окно с именем файла в заголовке
  $main = $null
  while (-not $main) { if ($p.HasExited) { throw 'TubesT закрылась' }; if ((Get-Date) -gt $deadline) { throw 'TubesT не открыла файл' }; Start-Sleep -Milliseconds 500; $main = Win { param($w) $w[1] -like ('*' + $name + '*') } }
  # импорт закончен, когда процессор затих
  $last = -1; $quiet = 0
  while ($quiet -lt 6) { Start-Sleep -Milliseconds 500; $p.Refresh(); $cpu = $p.TotalProcessorTime.TotalMilliseconds; if ($cpu - $last -lt 60) { $quiet++ } else { $quiet = 0 }; $last = $cpu; if ((Get-Date) -gt $deadline) { throw 'слишком долгий импорт' } }
  $d = Dlg; if ($d) { throw ('TubesT: ' + $d[1]) }
  $h = [IntPtr][long]$main[0]
  [void][TW]::Front($h); Start-Sleep -Milliseconds 400; $sh.SendKeys('{ESC}'); Start-Sleep -Milliseconds 300
  [TW]::Key(0x12); Start-Sleep -Milliseconds 500; $sh.SendKeys('2'); Start-Sleep -Milliseconds 700; $sh.SendKeys('{ENTER}')
  # окно «Сохранение»
  $save = $null; $t0 = Get-Date
  while (-not $save) { Start-Sleep -Milliseconds 300; $save = Win { param($w) $w[2] -eq '#32770' }; if (((Get-Date) - $t0).TotalSeconds -gt 20) { throw 'не открылось окно сохранения' } }
  [void][TW]::Front([IntPtr][long]$save[0]); Start-Sleep -Milliseconds 300
  Set-Clipboard -Value $dst
  $sh.SendKeys('^a'); Start-Sleep -Milliseconds 100; $sh.SendKeys('^v'); Start-Sleep -Milliseconds 300; $sh.SendKeys('{ENTER}')
  # ждём файл
  $t0 = Get-Date; $prev = -1
  while ($true) { Start-Sleep -Milliseconds 500
    if (Test-Path -LiteralPath $dst) { $len = (Get-Item -LiteralPath $dst).Length; if ($len -gt 0 -and $len -eq $prev) { break }; $prev = $len }
    if (((Get-Date) - $t0).TotalSeconds -gt 180) { throw 'файл .zzx не появился' } }
  [IO.Path]::GetFileName($dst)
} finally {
  if ($clip -ne $null) { try { Set-Clipboard -Value $clip } catch {} }
  if (-not $p.HasExited) {
    [void]$p.CloseMainWindow(); Start-Sleep -Seconds 2
    foreach ($w in [TW]::Wins([uint32]$p.Id)) { if ($w[2] -eq 'TMessageForm' -or $w[2] -eq '#32770') { [void][TW]::Front([IntPtr][long]$w[0]); Start-Sleep -Milliseconds 200; $sh.SendKeys('n') } }
    if (-not $p.WaitForExit(8000)) { Stop-Process -Id $p.Id -Force }
  }
}
`

func tubestConvert(exe, src string) (string, error) {
	script := strings.ReplaceAll(strings.ReplaceAll(tubestPS, "__SRC__", psq(src)), "__EXE__", psq(exe))
	out, err := runPS(script)
	if i := strings.Index(out, "ERR:"); i >= 0 {
		msg := strings.TrimSpace(out[i+4:])
		if j := strings.IndexAny(msg, "\r\n"); j > 0 {
			msg = msg[:j]
		}
		return "", errorString(msg)
	}
	if err != nil {
		return "", err
	}
	t := strings.TrimSpace(out)
	return t[strings.LastIndexAny(t, "\r\n")+1:], nil
}

type errorString string

func (e errorString) Error() string { return string(e) }
