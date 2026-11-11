# watch.ps1 — watch the running bot's live log in this terminal.
# Ctrl+C stops WATCHING only — it never kills the bot.
$repo = Split-Path -Parent $MyInvocation.MyCommand.Definition
$log = Join-Path $repo '.runtime\bot_out.log'
$bot = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'dist/cli.js' } | Select-Object -First 1
if ($bot) {
    Write-Host "BOT IS ON (PID $($bot.ProcessId)) — streaming log. Ctrl+C = stop watching only." -ForegroundColor Green
} else {
    Write-Host "WARNING: bot looks OFF right now — showing the last log lines anyway." -ForegroundColor Yellow
}
if (Test-Path $log) {
    Get-Content $log -Tail 50 -Wait
} else {
    Write-Host "No log at $log yet." -ForegroundColor Red
}
