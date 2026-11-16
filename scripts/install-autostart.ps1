# Starts the platform at every Windows logon of the current user, hidden (scheduled task "Personal AI platform").
# It runs in the user's own session so Windows notifications reach the screen. Remove it with:
#   Unregister-ScheduledTask -TaskName 'Personal AI platform' -Confirm:$false
$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'start-platform.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'conhost.exe' `
    -Argument "--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcher`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Personal AI platform' -Force -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description 'Starts the personal AI platform (http://127.0.0.1:8600) at logon, hidden.' | Out-Null
Get-ScheduledTask -TaskName 'Personal AI platform' | Select-Object TaskName, State
