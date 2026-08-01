$WshShell = New-Object -ComObject WScript.Shell

# Repoint the Start-menu "Agent Launcher" shortcut to always build+run from source
$lnk = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Agent Launcher.lnk"
$sc  = $WshShell.CreateShortcut($lnk)
$sc.TargetPath        = "wscript.exe"
$sc.Arguments         = """C:\Dev\agent-terminals\agent-launcher\launch.vbs"""
$sc.WorkingDirectory  = "C:\Dev\agent-terminals\agent-launcher"
$sc.IconLocation      = "C:\Dev\agent-terminals\agent-launcher\assets\icon.ico"
$sc.Description       = "Agent Launcher (always latest)"
$sc.Save()

# Remove the stale duplicate shortcut that points at the old NSIS install
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Agent Terminals.lnk" -ErrorAction SilentlyContinue

Write-Host "Done. Windows search 'Agent Launcher' will now build + launch the latest source." -ForegroundColor Green
