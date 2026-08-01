# Agent Launcher bootstrapper (run by the Start-menu shortcut via launch.vbs).
#
# Every click launches a NEW launcher instance — any number can run side by
# side. The first instance owns the default data dir and port 4575; each extra
# instance claims its own stable data dir (instance-2, instance-3, ...) and the
# next free control port (4576, 4577, ...) — that arbitration lives in the app
# itself (src/main/main.ts), not here.
#
# Build first only if dist is missing, so a normal click isn't blocked on a
# silent multi-second rebuild.

$proj = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $proj

if (-not (Test-Path (Join-Path $proj 'dist\main\main.js'))) {
  & cmd /c "npm run build"
}
$electron = Join-Path $proj 'node_modules\.bin\electron.cmd'
Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $proj -WindowStyle Hidden
exit 0
