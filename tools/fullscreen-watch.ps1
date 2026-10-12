# Watches the foreground window and reports whether a real fullscreen app is active.
# Prints 1 (fullscreen) or 0 (normal) once per interval. Desktop shell windows are ignored.
# Called by main.js with: powershell -NoProfile -ExecutionPolicy Bypass -File fullscreen-watch.ps1

Add-Type -MemberDefinition @"
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int l; public int t; public int r; public int b; }
"@ -Name A -Namespace W

$sb = New-Object System.Text.StringBuilder 256

while ($true) {
    $state = '0'
    try {
        $h = [W.A]::GetForegroundWindow()
        [void]$sb.Clear()
        [void][W.A]::GetClassName($h, $sb, 256)
        $cls = $sb.ToString()
        $r = New-Object 'W.A+RECT'
        [void][W.A]::GetWindowRect($h, [ref]$r)
        $w  = $r.r - $r.l
        $ht = $r.b - $r.t
        $sw = [W.A]::GetSystemMetrics(0)
        $sh = [W.A]::GetSystemMetrics(1)
        $isShell = ($cls -eq 'Progman') -or ($cls -eq 'WorkerW') -or `
                   ($cls -eq 'Shell_TrayWnd') -or ($cls -eq 'Shell_SecondaryTrayWnd')
        if ((-not $isShell) -and ($w -ge $sw) -and ($ht -ge $sh)) { $state = '1' }
    } catch {
        $state = '0'
    }
    [Console]::Out.WriteLine($state)
    [Console]::Out.Flush()
    Start-Sleep -Milliseconds 1200
}
