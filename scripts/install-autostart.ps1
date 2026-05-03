<#
  Install/uninstall a Windows Scheduled Task that runs `node server.js` at
  login, hidden, with no terminal window.

  Usage:
    .\scripts\install-autostart.ps1            # install
    .\scripts\install-autostart.ps1 -Uninstall # remove
    .\scripts\install-autostart.ps1 -Status    # check current state

  After install, the server starts automatically at every login. To start
  it right now without logging out, run:
    Start-ScheduledTask -TaskName 'YouTubeTranscriptServer'

  To stop it:
    Stop-ScheduledTask -TaskName 'YouTubeTranscriptServer'

  Logs go to: %LOCALAPPDATA%\YouTubeTranscriptServer\server.log
#>

[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$Status
)

$ErrorActionPreference = 'Stop'
$taskName = 'YouTubeTranscriptServer'
$repoRoot = Split-Path -Parent $PSScriptRoot
$serverJs = Join-Path $repoRoot 'server.js'
$logDir   = Join-Path $env:LOCALAPPDATA 'YouTubeTranscriptServer'
$logFile  = Join-Path $logDir 'server.log'

if ($Status) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Host "Task '$taskName' is NOT installed." -ForegroundColor Yellow
    return
  }
  Write-Host "Task '$taskName' is installed." -ForegroundColor Green
  $info = Get-ScheduledTaskInfo -TaskName $taskName
  Write-Host "  State           : $($task.State)"
  Write-Host "  Last run        : $($info.LastRunTime)"
  Write-Host "  Last result     : 0x$([Convert]::ToString($info.LastTaskResult, 16))"
  Write-Host "  Log file        : $logFile"
  $proc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
          Where-Object { $_.CommandLine -like "*server.js*" }
  if ($proc) {
    Write-Host "  Running PID(s)  : $($proc.ProcessId -join ', ')" -ForegroundColor Green
    try {
      $resp = Invoke-WebRequest 'http://localhost:3000/' -UseBasicParsing -TimeoutSec 3
      Write-Host "  HTTP check      : $($resp.StatusCode) OK" -ForegroundColor Green
    } catch {
      Write-Host "  HTTP check      : NOT responding" -ForegroundColor Yellow
    }
  } else {
    Write-Host "  Running PID(s)  : (none)" -ForegroundColor Yellow
  }
  return
}

if ($Uninstall) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Host "Task '$taskName' was not installed." -ForegroundColor Yellow
    return
  }
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Removed scheduled task '$taskName'." -ForegroundColor Green
  Write-Host "Note: log file kept at $logFile (delete manually if you want)."
  # Kill any straggler node.exe still serving server.js
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*server.js*" } |
    ForEach-Object {
      Write-Host "Stopping straggler node.exe PID $($_.ProcessId)"
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  return
}

# --- install path ---
if (-not (Test-Path $serverJs)) {
  throw "server.js not found at $serverJs"
}
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  throw "node.exe not found on PATH. Install Node.js first: https://nodejs.org/"
}
$nodeExe = $nodeCmd.Source
Write-Host "Using node : $nodeExe"
Write-Host "server.js  : $serverJs"
Write-Host "Log file   : $logFile"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# Wrapper script: redirects stdout/stderr to a log file and runs node.
$wrapperCmd = Join-Path $logDir 'run-server.cmd'
@"
@echo off
cd /d "$repoRoot"
"$nodeExe" "$serverJs" >> "$logFile" 2>&1
"@ | Set-Content -Path $wrapperCmd -Encoding ASCII

# VBS launcher — the only reliable way to run a console process on Windows
# with NO visible window (not even a flash). cmd.exe always shows briefly,
# even with -WindowStyle Hidden, because the scheduler creates the
# console before our flag takes effect.
$wrapperVbs = Join-Path $logDir 'run-server.vbs'
@"
Set s = CreateObject("WScript.Shell")
s.Run """$wrapperCmd""", 0, False
"@ | Set-Content -Path $wrapperVbs -Encoding ASCII

# If task already exists, remove it first so we can re-install cleanly.
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

# Action: run the VBS launcher (it spawns cmd hidden and exits immediately).
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$wrapperVbs`""

# Trigger: at user logon.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Settings: restart on failure, run only when logged in (no admin needed).
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 365)

# Principal: current user, interactive (so it can serve localhost).
$principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description 'Runs the YouTube Transcript Node server (server.js) on login, hidden.' | Out-Null

Write-Host ""
Write-Host "Installed scheduled task '$taskName'." -ForegroundColor Green
Write-Host ""
Write-Host "Starting server now..."
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2
try {
  $resp = Invoke-WebRequest 'http://localhost:3000/' -UseBasicParsing -TimeoutSec 5
  Write-Host "Server is up: HTTP $($resp.StatusCode)" -ForegroundColor Green
} catch {
  Write-Host "Server not responding yet. Check log: $logFile" -ForegroundColor Yellow
  Write-Host "  Get-Content '$logFile' -Tail 20"
}
Write-Host ""
Write-Host "Useful commands:"
Write-Host "  .\scripts\install-autostart.ps1 -Status      # check state"
Write-Host "  Start-ScheduledTask -TaskName '$taskName'    # start now"
Write-Host "  Stop-ScheduledTask  -TaskName '$taskName'    # stop now"
Write-Host "  .\scripts\install-autostart.ps1 -Uninstall   # remove autostart"
