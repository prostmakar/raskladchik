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

// один IGES → .zzx рядом, не мешая работать: TubesT открывает файл из командной строки, окно сразу уводится за край экрана,
// фокус возвращается обратно. Готовность — по журналу программы («Completed»). Дальше кнопка Export (сообщениями мыши в окно,
// без клавиатуры и без фокуса), в окне сохранения имя пишется прямо в поле и жмётся «Сохранить». Потом TubesT закрывается.
const tubestPS = `
$ErrorActionPreference='Stop'
trap { Write-Output ('ERR:' + $_.Exception.Message); exit 1 }
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public class TW {
  public delegate bool EP(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EP p, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EP p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool on);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  static string Txt(IntPtr h) { var t = new StringBuilder(512); GetWindowText(h, t, 512); return t.ToString(); }
  static string Cls(IntPtr h) { var c = new StringBuilder(256); GetClassName(h, c, 256); return c.ToString(); }
  public static List<object[]> Wins(uint pid) {
    var r = new List<object[]>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) r.Add(new object[] { h, Txt(h), Cls(h) }); return true; }, IntPtr.Zero);
    return r;
  }
  public static List<object[]> Kids(IntPtr w) {
    var r = new List<object[]>();
    EnumChildWindows(w, (h, l) => { r.Add(new object[] { h, Txt(h), Cls(h), GetDlgCtrlID(h) }); return true; }, IntPtr.Zero);
    return r;
  }
  public static string Text(IntPtr h) { int n = (int)SendMessage(h, 0x0E, IntPtr.Zero, IntPtr.Zero); var sb = new StringBuilder(n + 2); SendMessage(h, 0x0D, (IntPtr)(n + 1), sb); return sb.ToString(); }
  // окно за край экрана, под все остальные, без активации
  public static void Park(IntPtr h) { ShowWindow(h, 4); SetWindowPos(h, (IntPtr)1, -20000, -20000, 1920, 1040, 0x10); }
  // вернуть фокус окну пользователя (через присоединение к потоку текущего активного окна — иначе Windows не даёт)
  // только если фокус сейчас у TubesT (pid): пользователь мог уйти в другую программу — туда не лезем
  public static void Focus(IntPtr h, uint tpid) {
    if (h == IntPtr.Zero) return; IntPtr fg = GetForegroundWindow(); if (fg == h) return; uint pid;
    GetWindowThreadProcessId(fg, out pid); if (tpid != 0 && pid != tpid) return;
    uint a = GetCurrentThreadId(), b = GetWindowThreadProcessId(fg, out pid);
    AttachThreadInput(a, b, true); SetForegroundWindow(h); AttachThreadInput(a, b, false);
  }
  public static void Click(IntPtr h, int x, int y) {
    IntPtr lp = (IntPtr)((y << 16) | (x & 0xFFFF));
    PostMessage(h, 0x200, IntPtr.Zero, lp); System.Threading.Thread.Sleep(80);
    PostMessage(h, 0x201, (IntPtr)1, lp); System.Threading.Thread.Sleep(80);
    PostMessage(h, 0x202, IntPtr.Zero, lp);
  }
}
"@
$src = __SRC__; $exe = __EXE__
$dst = [IO.Path]::ChangeExtension($src, '.zzx')
$name = [IO.Path]::GetFileName($src)
$user = [TW]::GetForegroundWindow()
$p = Start-Process -FilePath $exe -ArgumentList ('"' + $src + '"') -PassThru
try {
  $pid0 = [uint32]$p.Id
  function Win($pred) { foreach ($w in [TW]::Wins($pid0)) { if (& $pred $w) { return $w } } return $null }
  # главное окно — сразу за край экрана и фокус обратно
  $main = $null; $t0 = Get-Date
  while (-not $main) { if ($p.HasExited) { throw 'TubesT закрылась' }; if (((Get-Date) - $t0).TotalSeconds -gt 90) { throw 'TubesT не открылась' }; Start-Sleep -Milliseconds 50; $main = Win { param($w) $w[2] -like 'T*Form*' -or $w[1] -like '*TubesT*' } }
  $mh = [IntPtr]$main[0]; [TW]::Park($mh); [TW]::Focus($user, $pid0)
  # журнал программы (TRichEdit): ждём «Completed» после открытия файла
  $log = $null; $t0 = Get-Date; $done = $false; $txt = ''
  while (-not $done) {
    Start-Sleep -Milliseconds 500
    if ($p.HasExited) { throw 'TubesT закрылась' }
    $w = Win { param($w) $w[1] -like ('*' + $name + '*') }; if ($w) { $mh = [IntPtr]$w[0] }
    [TW]::Park($mh); [TW]::Focus($user, $pid0)
    $d = Win { param($w) $w[2] -eq 'TMessageForm' -or $w[2] -eq '#32770' }; if ($d) { throw ('TubesT: ' + $d[1] + ' ' + (([TW]::Kids([IntPtr]$d[0]) | ForEach-Object { $_[1] }) -join ' ')) }
    if (-not $log) { foreach ($k in [TW]::Kids($mh)) { if ($k[2] -like '*RichEdit*') { $log = [IntPtr]$k[0] } } }
    if ($log) { $txt = [TW]::Text($log); $i = $txt.LastIndexOf('Open Files'); if ($i -ge 0 -and $txt.IndexOf('Completed', $i) -ge 0) { $done = $true } }
    if (((Get-Date) - $t0).TotalMinutes -gt 20) { throw 'слишком долгий импорт' }
  }
  if ($txt -match '(?i)does not match|error|fail') { $bad = ($txt.Substring($txt.LastIndexOf('Open Files')) -split "\r?\n" | Where-Object { $_ -match '(?i)does not match|error|fail' } | Select-Object -First 1); if ($bad) { throw ('TubesT: ' + $bad) } }
  Start-Sleep -Milliseconds 500
  # кнопка Export: группа «Locating the file», вторая кнопка
  $grp = $null; foreach ($k in [TW]::Kids($mh)) { if ($k[2] -eq 'TdxRibbonGroupBarControl' -and $k[1] -eq 'Locating the file') { $grp = [IntPtr]$k[0] } }
  if (-not $grp) { throw 'не нашёл кнопку Export' }
  $save = $null
  for ($try = 0; $try -lt 3 -and -not $save; $try++) {
    [TW]::Click($grp, 70, 36)
    $t0 = Get-Date
    while (-not $save -and ((Get-Date) - $t0).TotalSeconds -lt 8) { Start-Sleep -Milliseconds 200; $save = Win { param($w) $w[2] -eq '#32770' } }
  }
  if (-not $save) { throw 'не открылось окно сохранения' }
  $sh = [IntPtr]$save[0]; [TW]::SetWindowPos($sh, [IntPtr]1, -20000, -20000, 0, 0, 0x15) | Out-Null; [TW]::Focus($user, $pid0)
  # поле имени файла: Edit (в старом окне — внутри ComboBox 1148, в новом — Edit 1001)
  $kids = [TW]::Kids($sh); $edit = $null
  foreach ($k in $kids) { if ($k[2] -eq 'Edit' -and ($k[3] -eq 1001 -or $k[3] -eq 1148 -or $k[3] -eq 1152)) { $edit = [IntPtr]$k[0] } }
  if (-not $edit) { foreach ($k in $kids) { if ($k[2] -eq 'Edit') { $edit = [IntPtr]$k[0]; break } } }
  if (-not $edit) { throw 'нет поля имени файла' }
  [TW]::SendMessage($edit, 0x0C, [IntPtr]::Zero, $dst) | Out-Null
  Start-Sleep -Milliseconds 200
  [TW]::PostMessage($sh, 0x111, [IntPtr]1, [IntPtr]::Zero) | Out-Null   # WM_COMMAND IDOK = «Сохранить»
  # ждём файл
  $t0 = Get-Date; $prev = -1
  while ($true) { Start-Sleep -Milliseconds 500
    if (Test-Path -LiteralPath $dst) { $len = (Get-Item -LiteralPath $dst).Length; if ($len -gt 0 -and $len -eq $prev) { break }; $prev = $len }
    $d = Win { param($w) $w[2] -eq 'TMessageForm' -or ($w[2] -eq '#32770' -and [IntPtr]$w[0] -ne $sh) }; if ($d) { throw ('TubesT: ' + $d[1] + ' ' + (([TW]::Kids([IntPtr]$d[0]) | ForEach-Object { $_[1] }) -join ' ')) }
    if (((Get-Date) - $t0).TotalSeconds -gt 180) { throw 'файл .zzx не появился' } }
  Start-Sleep -Milliseconds 800
  [IO.Path]::GetFileName($dst)
} finally {
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  [TW]::Focus($user, $pid0)
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
