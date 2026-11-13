//go:build windows

package main

import (
	"encoding/base64"
	"fmt"
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

func tubestRunning() bool { return tubestCount() > 0 }

// один IGES → .zzx рядом. Просто и надёжно: TubesT открывает файл из командной строки и выходит на передний план,
// дальше Alt → «2» → Enter («Сохранить как» на панели быстрого доступа). Клавиши уходят только если впереди именно TubesT.
// В окне сохранения путь вписывается через UI Automation, «Сохранить» — им же. Потом TubesT закрывается.
const tubestPS = `
$ErrorActionPreference='Stop'
trap { try { Add-Content -LiteralPath (Join-Path $env:TEMP 'Raskladchik_tubest.log') -Value ('ERR ' + $_.Exception.Message) -Encoding UTF8 } catch {}; Write-Output ('ERR:' + $_.Exception.Message); exit 1 }
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public class TW {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EP p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte sc, uint fl, UIntPtr ex);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool on);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  static string Txt(IntPtr h) { var t = new StringBuilder(512); GetWindowText(h, t, 512); return t.ToString(); }
  static string Cls(IntPtr h) { var c = new StringBuilder(256); GetClassName(h, c, 256); return c.ToString(); }
  public static List<object[]> Wins(uint pid) {
    var r = new List<object[]>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) r.Add(new object[] { h, Txt(h), Cls(h) }); return true; }, IntPtr.Zero);
    return r;
  }
  public static uint FgPid() { uint p; GetWindowThreadProcessId(GetForegroundWindow(), out p); return p; }
  // вывести окно вперёд: Windows не даёт это фоновой программе — обходим нажатием Alt и присоединением к потоку активного окна
  public static bool Front(IntPtr h, uint pid) {
    for (int i = 0; i < 6; i++) {
      if (FgPid() == pid) return true;
      IntPtr fg = GetForegroundWindow(); uint x; uint a = GetCurrentThreadId(), b = GetWindowThreadProcessId(fg, out x);
      keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
      AttachThreadInput(a, b, true); ShowWindow(h, 3); BringWindowToTop(h); SetForegroundWindow(h); AttachThreadInput(a, b, false);
      System.Threading.Thread.Sleep(300);
    }
    return FgPid() == pid;
  }
  public static void Back(IntPtr h) {
    if (h == IntPtr.Zero) return; IntPtr fg = GetForegroundWindow(); uint x; uint a = GetCurrentThreadId(), b = GetWindowThreadProcessId(fg, out x);
    AttachThreadInput(a, b, true); SetForegroundWindow(h); AttachThreadInput(a, b, false);
  }
  // клавиша — только если впереди TubesT; иначе ничего не жмём
  public static bool Combo(byte mod, byte vk, uint pid) { if (FgPid() != pid) return false; keybd_event(mod, 0, 0, UIntPtr.Zero); keybd_event(vk, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(40); keybd_event(vk, 0, 2, UIntPtr.Zero); keybd_event(mod, 0, 2, UIntPtr.Zero); return true; }
  public static bool Key(byte vk, uint pid) { if (FgPid() != pid) return false; keybd_event(vk, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(40); keybd_event(vk, 0, 2, UIntPtr.Zero); return true; }
}
"@
$src = __SRC__; $exe = __EXE__
$logf = Join-Path $env:TEMP 'Raskladchik_tubest.log'
function L($m) { try { Add-Content -LiteralPath $logf -Value ((Get-Date).ToString('HH:mm:ss.fff') + ' ' + $m) -Encoding UTF8 } catch {} }
L ('=== ' + $src)
$dst = [IO.Path]::ChangeExtension($src, '.zzx')
$user = [TW]::GetForegroundWindow()
$p = Start-Process -FilePath $exe -ArgumentList ('"' + $src + '"') -PassThru
try {
  $pid0 = [uint32]$p.Id
  function Win($pred) { foreach ($w in [TW]::Wins($pid0)) { if (& $pred $w) { return $w } } return $null }
  # файл открыт: в заголовке «имя - TubesT…», программа отвечает
  $t0 = Get-Date; $main = $null; $hang = 0
  while ($true) {
    Start-Sleep -Milliseconds 500
    if ($p.HasExited) { throw 'TubesT закрылась' }
    $d = Win { param($w) $w[2] -eq 'TMessageForm' -or $w[2] -eq '#32770' }; if ($d) { throw ('TubesT: ' + $d[1]) }
    $p.Refresh(); if ($p.Responding) { $hang = 0 } else { $hang++ }
    if ($hang -gt 240) { throw 'TubesT зависла на этом файле' }
    $main = Win { param($w) $w[2] -eq 'TfrmTubest' }
    if ($main -and $p.Responding -and ([string]$main[1]).Contains(' - TubesT')) { break }
    if (((Get-Date) - $t0).TotalMinutes -gt 20) { throw 'слишком долгий импорт' }
  }
  L ('loaded: ' + $main[1])
  Start-Sleep -Milliseconds 1500
  $mh = [IntPtr]$main[0]; $save = $null
  for ($try = 0; $try -lt 3 -and -not $save; $try++) {
    if (-not [TW]::Front($mh, $pid0)) { L 'не вышла вперёд'; Start-Sleep -Milliseconds 800; continue }
    Start-Sleep -Milliseconds 400
    $ok = [TW]::Key(0x1B, $pid0); Start-Sleep -Milliseconds 300
    $ok = $ok -and [TW]::Key(0x12, $pid0); Start-Sleep -Milliseconds 700
    $ok = $ok -and [TW]::Key(0x32, $pid0); Start-Sleep -Milliseconds 900
    $ok = $ok -and [TW]::Key(0x0D, $pid0)
    L ('keys ' + $ok)
    $t1 = Get-Date
    while (-not $save -and ((Get-Date) - $t1).TotalSeconds -lt 8) { Start-Sleep -Milliseconds 200; $save = Win { param($w) $w[2] -eq '#32770' } }
    if (-not $save) { [void][TW]::Key(0x1B, $pid0); [void][TW]::Key(0x1B, $pid0) }
  }
  if (-not $save) { throw 'не открылось окно сохранения' }
  Start-Sleep -Milliseconds 600
  # в окне сохранения курсор уже в поле «Имя файла»: полный путь — через буфер обмена (Ctrl+A, Ctrl+V, Enter)
  $clip = $null; try { $clip = Get-Clipboard -Raw } catch {}
  try {
    Set-Clipboard -Value $dst; Start-Sleep -Milliseconds 200
    if (-not [TW]::Front([IntPtr]$save[0], $pid0)) { throw 'окно сохранения не вышло вперёд' }
    if (-not [TW]::Combo(0x11, 0x41, $pid0)) { throw 'фокус ушёл из TubesT' }; Start-Sleep -Milliseconds 200
    if (-not [TW]::Combo(0x11, 0x56, $pid0)) { throw 'фокус ушёл из TubesT' }; Start-Sleep -Milliseconds 400
    if (-not [TW]::Key(0x0D, $pid0)) { throw 'фокус ушёл из TubesT' }
    L 'path pasted'
  } finally { Start-Sleep -Milliseconds 500; if ($clip -ne $null) { try { Set-Clipboard -Value $clip } catch {} } }
  $t0 = Get-Date; $prev = -1
  while ($true) { Start-Sleep -Milliseconds 500
    if (Test-Path -LiteralPath $dst) { $len = (Get-Item -LiteralPath $dst).Length; if ($len -gt 0 -and $len -eq $prev) { break }; $prev = $len; continue }
    $d = Win { param($w) $w[2] -eq 'TMessageForm' -or ($w[2] -eq '#32770' -and [IntPtr]$w[0] -ne [IntPtr]$save[0]) }; if ($d) { throw ('TubesT: ' + $d[1]) }
    if (((Get-Date) - $t0).TotalSeconds -gt 120) { throw 'файл .zzx не появился' } }
  Start-Sleep -Milliseconds 800
  L 'ok'
  [IO.Path]::GetFileName($dst)
} finally {
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  [TW]::Back($user)
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

// папки, открытые сейчас в окнах Проводника (оттуда обычно и перетаскивают)
func explorerDirs() []string {
	out, err := runPS("$s=New-Object -ComObject Shell.Application; foreach($w in $s.Windows()){ try { $p=$w.Document.Folder.Self.Path; if($p -and (Test-Path -LiteralPath $p)){ $p } } catch {} }")
	if err != nil {
		return nil
	}
	var r []string
	for _, l := range strings.Split(strings.ReplaceAll(out, "\r", ""), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			r = append(r, l)
		}
	}
	return r
}

func downloadsDir() string {
	out, err := runPS("(New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path")
	if p := strings.TrimSpace(out); err == nil && p != "" {
		return p
	}
	if h, e := os.UserHomeDir(); e == nil {
		return filepath.Join(h, "Downloads")
	}
	return ""
}

// сколько TubesT запущено сейчас
func tubestCount() int {
	out, _ := runPS("@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'TubesT*' }).Count")
	n := 0
	fmt.Sscan(strings.TrimSpace(out), &n)
	return n
}
