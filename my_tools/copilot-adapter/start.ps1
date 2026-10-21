# Start the OpenAI-compatible Copilot adapter.
#
#   .\start.ps1              # foreground, http://127.0.0.1:7777
#   .\start.ps1 -Reload      # auto-reload while editing code
#
# Prefers the Workspace virtualenv (already has fastapi/httpx), then falls back
# to a system Python.

param([switch]$Reload)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$candidates = @(
    "D:\work\trade\workspace\.venv\Scripts\python.exe",
    "C:\Users\pc\.workbuddy\binaries\python\versions\3.13.12\python.exe",
    "python"
)

$python = $null
foreach ($candidate in $candidates) {
    if ($candidate -eq "python") { $python = "python"; break }
    if (Test-Path $candidate) { $python = $candidate; break }
}

if (-not (Test-Path (Join-Path $here ".env"))) {
    Copy-Item (Join-Path $here ".env.example") (Join-Path $here ".env")
    Write-Host "Created .env from template - fill in OPENAI_API_KEY, then rerun." -ForegroundColor Yellow
    exit 1
}

Set-Location $here
$args = @("-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "7777")
if ($Reload) { $args += "--reload" }

Write-Host "python: $python" -ForegroundColor DarkGray
Write-Host "adapter: http://127.0.0.1:7777/agents.json" -ForegroundColor Green
& $python @args
