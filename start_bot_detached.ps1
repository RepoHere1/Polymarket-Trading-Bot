# start_bot_detached.ps1 - launch the bot DETACHED from any parent shell.
#
# WHY THIS EXISTS (2026-11-13): start_bot.ps1 runs `node dist/cli.js` as a
# foreground child of a PowerShell pipeline. When the bot is started by an
# automation agent, that wrapper sits in the agent's process tree and the
# node child dies with it (observed twice: bot died at +2m32s and +50s with
# zero stderr, while the wrapper survived). This script does the same env
# merge + port guard, then spawns node detached with stdout/stderr redirected
# straight into .runtime files - no pipeline, no reaper can reach it.
# watch.ps1 keeps streaming .runtime\bot_out.log unchanged.
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
Merge-EnvFile (Join-Path $repo ".env")
Merge-EnvFile "D:\master.env"

if ($Live) { $env:ENABLE_LIVE_TRADING = "true" } else { $env:ENABLE_LIVE_TRADING = "" }

# duplicate-start guard: refuse to fight over the dashboard port.
$dp = if ($env:DASHBOARD_PORT) { $env:DASHBOARD_PORT } else { "3000" }
$owner = (netstat -ano | Select-String ":$dp\s.*LISTENING") |
    ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -First 1
if ($owner) {
    Write-Host "ABORTED: port $dp already in use (PID $owner) - a bot is already running."
    exit 1
}

$runtime = Join-Path $repo '.runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
# Fresh log per run (same contract as start_bot.ps1).
Set-Content -Path (Join-Path $runtime 'bot_out.log') -Value '' -NoNewline
Set-Content -Path (Join-Path $runtime 'bot_err.log') -Value '' -NoNewline

Write-Host ("PAPER trading mode (detached). LIVE=" + [bool]$env:ENABLE_LIVE_TRADING)
Write-Host "Dashboard: http://localhost:$dp/dashboard"
Write-Host "Logs: .runtime\bot_out.log (stdout) / .runtime\bot_err.log (stderr)"

Start-Process -FilePath 'node' -ArgumentList 'dist\cli.js','start','--config',$Config `
    -WorkingDirectory $repo -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $runtime 'bot_out.log') `
    -RedirectStandardError (Join-Path $runtime 'bot_err.log')
Write-Host "node launched detached."
