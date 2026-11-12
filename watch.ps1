# watch.ps1 - watch the running bot's live log in this terminal.
# Ctrl+C stops WATCHING only - it never kills the bot.
$repo = Split-Path -Parent $MyInvocation.MyCommand.Definition
$log = Join-Path $repo '.runtime\bot_out.log'
$bot = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'dist/cli.js' } | Select-Object -First 1
if ($bot) {
    Write-Host "BOT IS ON (PID $($bot.ProcessId)) - streaming log. Ctrl+C = stop watching only." -ForegroundColor Green
} else {
    Write-Host "WARNING: bot looks OFF right now - showing the last log lines anyway." -ForegroundColor Yellow
}
if (Test-Path $log) {
    if ($bot) {
        # Warn when the log predates the running bot (stale corpse of an old instance).
        $logAge = ((Get-Item $log).LastWriteTime) - $bot.CreationDate
        if ($logAge.TotalSeconds -lt -5) {
            Write-Host "NOTE: log file is older than the running bot - it may be missing recent lines until the next restart." -ForegroundColor Yellow
        }
    }
    Get-Content $log -Tail 50 -Wait
} else {
    Write-Host "No log at $log yet." -ForegroundColor Red
}
