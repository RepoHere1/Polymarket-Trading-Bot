# start_bot.ps1 — launch the Polymarket-Trading-Bot with secrets wired.
#
# Load order (later overrides earlier):
#   1. repo-local .env          (gitignored — minimal, safe to keep here)
#   2. D:\master.env            (the full machine credential registry)
#   3. existing process env     (anything you set before calling this script)
#
# ENABLE_LIVE_TRADING is left UNSET by default → paper trading only.
# Set $env:ENABLE_LIVE_TRADING='true' to arm a LIVE wallet.
param(
    [string]$Config = "config.yaml",
    [switch]$Live
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location -Path $repo

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
# 2. master credential registry on D:
Merge-EnvFile "D:\master.env"
# 3. safety: live trading must be explicitly opted into
if ($Live) {
    $env:ENABLE_LIVE_TRADING = "true"
    Write-Host "!!! LIVE TRADING ARMED !!!"
} else {
    $env:ENABLE_LIVE_TRADING = ""
    Write-Host "PAPER TRADING MODE (safe default)"
}

Write-Host "POLYMARKET_API_KEY set: $([bool]$env:POLYMARKET_API_KEY)"
Write-Host "OPENROUTER_API_KEY set:   $([bool]$env:OPENROUTER_API_KEY)"
Write-Host "POLYGON_RPC set:         $([bool]$env:POLYGON_RPC)"
Write-Host "Dashboard: http://localhost:$($env:DASHBOARD_PORT ?? 3000)/dashboard"
Write-Host ""

node dist/cli.js start --config $Config