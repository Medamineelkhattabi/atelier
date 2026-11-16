# Stops the platform server: the "Personal AI platform" logon task and the server it started (the program
# listening on port 8600). Stopping the task alone leaves the server running. Running tasks are marked
# "interrupted" and can be resumed after the next start.
Stop-ScheduledTask -TaskName 'Personal AI platform' -ErrorAction SilentlyContinue
foreach ($connection in Get-NetTCPConnection -LocalPort 8600 -State Listen -ErrorAction SilentlyContinue) {
    $server = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)"
    if (-not $server -or $server.CommandLine -notmatch 'personal-ai-engineering|pae') {
        Write-Warning "Port 8600 is used by another program; it was not stopped."
        continue
    }
    $launcher = Get-CimInstance Win32_Process -Filter "ProcessId=$($server.ParentProcessId)"
    Stop-Process -Id $server.ProcessId -Force
    if ($launcher -and $launcher.CommandLine -match 'pae') {
        Stop-Process -Id $launcher.ProcessId -Force -ErrorAction SilentlyContinue
    }
    "Platform stopped."
}
