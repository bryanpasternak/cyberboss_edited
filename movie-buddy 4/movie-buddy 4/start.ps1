$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectRoot

$port = 4174
foreach ($file in @('config.example.json', 'config.json')) {
    if (Test-Path -LiteralPath $file) {
        $config = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
        if ($config.server -and $config.server.port) { $port = [int]$config.server.port }
    }
}

try {
    $running = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/state" -TimeoutSec 1
    if ($running) {
        Start-Process "http://127.0.0.1:$port/"
        return
    }
} catch {
    # The local service is not running yet.
}

$pythonCommand = Get-Command python -ErrorAction Stop
& $pythonCommand.Source server.py
