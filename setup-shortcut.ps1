$WshShell = New-Object -ComObject WScript.Shell

$lnk = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Agent Launcher ADE.lnk"
$sc  = $WshShell.CreateShortcut($lnk)
$install = "$env:LOCALAPPDATA\Agent Launcher ADE"
$sc.TargetPath        = Join-Path $install "agent-launcher.exe"
$sc.WorkingDirectory  = $install
$sc.IconLocation      = Join-Path $install "agent-launcher.exe"
$sc.Description       = "Agent Launcher ADE"
$sc.Save()

Write-Host "Done. Windows search 'Agent Launcher' will now also show 'Agent Launcher ADE'." -ForegroundColor Green
