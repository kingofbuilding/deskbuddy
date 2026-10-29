param([switch]$Daemon)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DeskBuddyWindows {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
}
'@

while ($null -ne ($requestLine = [Console]::ReadLine())) {
  $request = $null
  try {
    $request = $requestLine | ConvertFrom-Json
    $window = if ($request.command -eq 'sample') { [DeskBuddyWindows]::GetForegroundWindow() } else { [IntPtr]([long]$request.handle) }
    if ($window -eq [IntPtr]::Zero -or -not [DeskBuddyWindows]::IsWindow($window)) { throw 'window_missing' }
    [uint32]$targetProcessId = 0
    [void][DeskBuddyWindows]::GetWindowThreadProcessId($window, [ref]$targetProcessId)
    $targetProcess = Get-Process -Id $targetProcessId -ErrorAction Stop
    $exeName = $targetProcess.ProcessName.ToLowerInvariant() + '.exe'
    if ($request.command -eq 'sample') {
      $result = @{ ok=$true; process=$exeName; handle=$window.ToInt64().ToString(); processId=$targetProcessId }
    } else {
      if ($request.expected -notmatch '^[a-z0-9_. -]{1,80}\.exe$' -or $exeName -ne $request.expected -or $targetProcessId -ne [uint32]$request.processId) { throw 'target_changed' }
      switch ($request.command) {
        'minimize' {
          [void][DeskBuddyWindows]::ShowWindowAsync($window, 6)
          for ($attempt = 0; $attempt -lt 8 -and -not [DeskBuddyWindows]::IsIconic($window); $attempt++) { Start-Sleep -Milliseconds 40 }
          $success = [DeskBuddyWindows]::IsIconic($window)
        }
        'close' { $success = [DeskBuddyWindows]::PostMessage($window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
        default { throw 'unsupported_command' }
      }
      $result = @{ ok=[bool]$success }
    }
    $result.id = $request.id
    [Console]::WriteLine(($result | ConvertTo-Json -Compress))
  } catch {
    [Console]::WriteLine((@{ id=$request.id; ok=$false; error=$_.Exception.Message } | ConvertTo-Json -Compress))
  }
}
