# start_bot.ps1 - launch the Polymarket-Trading-Bot with secrets wired.
#
# Load order (later overrides earlier):
#   1. repo-local .env          (gitignored - minimal, safe to keep here)
#   2. D:\master.env            (the full machine credential registry)
#   3. existing process env     (anything you set before calling this script)
#
# ENABLE_LIVE_TRADING is left UNSET by default -> paper trading only.
# Set $env:ENABLE_LIVE_TRADING='true' (or pass -Live) to arm a LIVE wallet.
param(
    [string]$Config = "config.yaml",
    [switch]$Live
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location -Path $repo

# Canonical log file - watch.ps1 streams exactly this file.
$botLog = Join-Path $repo '.runtime\bot_out.log'
New-Item -ItemType Directory -Force -Path (Join-Path $repo '.runtime') | Out-Null

function Merge-EnvFile($path) {
    if (-not (Test-Path $path)) { return }
    Get-Content $path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) { return }
        $parts = $line.Split("=", 2)
        if ($parts.Count -ne 2) { return }
        $k = $parts[0].Trim()
        $v = $parts[1].Trim().Trim('"').Trim("'")
        if ($k) { Set-Item -Path "env:$k" -Value $v }
    }
}

# 1. repo-local .env
Merge-EnvFile (Join-Path $repo ".env")
# 2. master credential registry on D:\
Merge-EnvFile "D:\master.env"
# 3. safety: live trading must be explicitly opted into
if ($Live) {
    $env:ENABLE_LIVE_TRADING = "true"
    Write-Host "!!! LIVE TRADING ARMED !!!"
} else {
    $env:ENABLE_LIVE_TRADING = ""
    Write-Host "PAPER TRADING MODE (safe default)"
}

# 4. duplicate-start guard: refuse to fight over the dashboard port.
$dp = if ($env:DASHBOARD_PORT) { $env:DASHBOARD_PORT } else { "3000" }
$owner = (netstat -ano | Select-String ":$dp\s.*LISTENING") |
    ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -First 1
if ($owner) {
    $ownerCmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue).CommandLine
    Write-Host ""
    Write-Host "ABORTED: port $dp is already in use (PID $owner)." -ForegroundColor Red
    if ($ownerCmd) { Write-Host "  that process: $ownerCmd" }
    Write-Host "A bot instance is already running - the dashboard is at http://localhost:$dp/dashboard"
    Write-Host "Stream its log with:  .\watch.ps1"
    Write-Host "(To stop it:  Stop-Process -Id $owner )"
    exit 1
}

Write-Host "POLYMARKET_API_KEY set: $([bool]$env:POLYMARKET_API_KEY)"
Write-Host "OPENROUTER_API_KEY set:   $([bool]$env:OPENROUTER_API_KEY)"
Write-Host "POLYGON_RPC set:         $([bool]$env:POLYGON_RPC)"
Write-Host "Dashboard: http://localhost:$dp/dashboard"
Write-Host "Logging to: $botLog"
Write-Host ""

# Fresh log per run so watch.ps1 never shows a dead instance's spam.
Set-Content -Path $botLog -Value '' -NoNewline
# Node writes UTF-8. Force PowerShell to DECODE its stdout as UTF-8, or every
# em-dash/arrow/multiplication sign in log lines becomes mojibake (the
# "Gamma-hat" garbage) once it passes through this pipe.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

# Tee the log as UTF-8 WITH BOM so any reader (watch.ps1, editors, type) decodes
# it correctly on every PowerShell version.
$logWriter = New-Object System.IO.StreamWriter($botLog, $false, (New-Object System.Text.UTF8Encoding($true)))
$logWriter.AutoFlush = $true
try {
    node dist/cli.js start --config $Config 2>&1 | ForEach-Object {
        $line = $_.ToString()
        $logWriter.WriteLine($line)
        Write-Output $line
    }
} finally {
    $logWriter.Close()
}
