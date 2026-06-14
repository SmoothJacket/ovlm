# OVLM NUC installer
# Run once in an elevated PowerShell prompt:
#   Set-ExecutionPolicy -Scope Process Bypass
#   .\install.ps1
#
# What it does:
#   1. Creates a Python virtualenv at %USERPROFILE%\ovlm-venv
#   2. Installs Python dependencies into the venv
#   3. Registers a Task Scheduler task that launches OVLM at logon

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvDir   = "$env:USERPROFILE\ovlm-venv"
$TaskName  = "OVLM"

Write-Host "=== OVLM NUC installer ===" -ForegroundColor Cyan
Write-Host "Project dir : $ScriptDir"
Write-Host "Virtualenv  : $VenvDir"
Write-Host ""

# ── 1. Check Python ────────────────────────────────────────────────────────────
Write-Host "[1/3] Checking Python ..."
$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonCmd) {
    Write-Host "Python not found. Install Python 3.10+ from https://python.org" -ForegroundColor Red
    exit 1
}
$ver = & python --version
Write-Host "  Found: $ver"

# ── 2. Virtualenv + dependencies ───────────────────────────────────────────────
Write-Host ""
Write-Host "[2/3] Setting up virtualenv at $VenvDir ..."
if (-not (Test-Path $VenvDir)) {
    python -m venv $VenvDir
}
& "$VenvDir\Scripts\pip" install --upgrade pip --quiet
& "$VenvDir\Scripts\pip" install -r "$ScriptDir\requirements.txt" --quiet

Write-Host "  Installed packages:"
& "$VenvDir\Scripts\pip" list --format=columns |
    Select-String "opencv|numpy|websockets|pyaudio|pyserial|psutil"

# ── 3. Task Scheduler ─────────────────────────────────────────────────────────
Write-Host ""
Write-Host "[3/3] Registering Task Scheduler task '$TaskName' ..."

$action = New-ScheduledTaskAction `
    -Execute   "$VenvDir\Scripts\python.exe" `
    -Argument  "main.py" `
    -WorkingDirectory $ScriptDir

$trigger = New-ScheduledTaskTrigger -AtLogon

$settings = New-ScheduledTaskSettingsSet `
    -RestartCount    5 `
    -RestartInterval (New-TimeSpan -Seconds 10) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action   $action `
    -Trigger  $trigger `
    -Settings $settings `
    -RunLevel Highest `
    -Force | Out-Null

Write-Host ""
Write-Host "=== Installation complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Manage the service:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'     # start now"
Write-Host "  Stop-ScheduledTask  -TaskName '$TaskName'     # stop"
Write-Host "  Get-ScheduledTask   -TaskName '$TaskName'     # status"
Write-Host ""
Write-Host "Or run directly in a terminal:"
Write-Host "  & '$VenvDir\Scripts\python.exe' main.py"
Write-Host ""
Write-Host "IMPORTANT: Run calibration before starting. Either:"
Write-Host "  cd '$ScriptDir'"
Write-Host "  & '$VenvDir\Scripts\python.exe' plate_calib.py --live   # home plate in view, no board"
Write-Host "  & '$VenvDir\Scripts\python.exe' calibrate.py  --live   # ChArUco board"
Write-Host ""
Write-Host "Connect the browser dashboard to: ws://localhost:8765"
Write-Host "(or ws://<nuc-ip>:8765 from another machine on the same network)"
Write-Host ""

$answer = Read-Host "Start the task now? [y/N]"
if ($answer -eq 'y' -or $answer -eq 'Y') {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Task started." -ForegroundColor Green
    Write-Host "View logs: Get-EventLog -LogName Application -Source OVLM -Newest 20"
}
