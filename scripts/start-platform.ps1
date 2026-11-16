# Starts the platform server (http://127.0.0.1:8600) for the "Personal AI platform" scheduled task at logon.
# The task runs it through `conhost.exe --headless`, so no window appears and the programs the server starts
# (Claude Code, docker, notifications) share that hidden console. Output: ~/.pae/server.log (errors and logs)
# and ~/.pae/server.out.log. Set up with scripts/install-autostart.ps1.
$ErrorActionPreference = 'Stop'
$backend = Join-Path (Split-Path $PSScriptRoot -Parent) 'backend'
$data = Join-Path $env:USERPROFILE '.pae'
New-Item -ItemType Directory -Force $data | Out-Null
$server = Start-Process -FilePath (Join-Path $backend '.venv\Scripts\pae.exe') -ArgumentList 'serve' `
    -WorkingDirectory $backend -NoNewWindow -PassThru `
    -RedirectStandardOutput (Join-Path $data 'server.out.log') -RedirectStandardError (Join-Path $data 'server.log')
$server.WaitForExit()
exit $server.ExitCode
