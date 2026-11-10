# Prints "<process> | <window title>" for the current foreground window.
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public class SpcFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
$h = [SpcFg]::GetForegroundWindow()
$sb = New-Object Text.StringBuilder 256
[void][SpcFg]::GetWindowText($h, $sb, 256)
$p = 0
[void][SpcFg]::GetWindowThreadProcessId($h, [ref]$p)
$name = try { (Get-Process -Id $p -ErrorAction Stop).ProcessName } catch { '?' }
"$name | $($sb.ToString())"
