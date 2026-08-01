$WshShell = New-Object -ComObject WScript.Shell

$lnk = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Agent Launcher ADE.lnk"
$sc  = $WshShell.CreateShortcut($lnk)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$sc.TargetPath       = Join-Path $root "src-tauri\target\release\agent-launcher.exe"
$sc.WorkingDirectory  = Join-Path $root "src-tauri\target\release"
$sc.IconLocation      = Join-Path $root "src-tauri\icons\icon.ico"
$sc.Description       = "Agent Launcher ADE (Tauri, orange icon, new build)"
$sc.Save()

Write-Host "Done. Windows search 'Agent Launcher' will now also show 'Agent Launcher ADE'." -ForegroundColor Green
