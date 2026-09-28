# Installs the AIMS backend and AI service as Windows Services using NSSM, so both auto-start on
# boot (no user needs to be logged in) and restart automatically if either crashes.
#
# Run as Administrator, after:
#   - npm install in backend/ and frontend/, and `npm run build` in frontend/ (see deploy/INSTALL.md)
#   - pip install -r requirements.txt in ai-service/'s venv
#   - backend/.env and ai-service/.env filled in for production (see .env.example in each,
#     NODE_ENV=production in both)
#
# Requires NSSM (https://nssm.cc/download) — extract nssm.exe (the win64 build) somewhere on PATH
# first; this script does not install NSSM itself.

param(
    [string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path
)

$nssmCmd = Get-Command nssm -ErrorAction SilentlyContinue
if (-not $nssmCmd) {
    Write-Error "nssm.exe not found on PATH. Download it from https://nssm.cc/download, extract nssm.exe (the win64 build) somewhere on PATH, then re-run this script."
    exit 1
}

$node = (Get-Command node -ErrorAction Stop).Source
$backendDir = Join-Path $RepoRoot "backend"
$backendLogDir = Join-Path $backendDir "logs"
New-Item -ItemType Directory -Force -Path $backendLogDir | Out-Null

Write-Host "Installing AimsBackend service..."
nssm install AimsBackend $node "index.js"
nssm set AimsBackend AppDirectory $backendDir
nssm set AimsBackend AppEnvironmentExtra "NODE_ENV=production"
nssm set AimsBackend AppStdout (Join-Path $backendLogDir "backend.log")
nssm set AimsBackend AppStderr (Join-Path $backendLogDir "backend.log")
# NSSM's own file rotation, since the app writes structured JSON to stdout only (see
# deployment.md Phase 3) and relies on whatever runs it to redirect and rotate that into a file.
nssm set AimsBackend AppRotateFiles 1
nssm set AimsBackend AppRotateOnline 1
nssm set AimsBackend AppRotateBytes 10485760
nssm set AimsBackend AppRestartDelay 3000
nssm set AimsBackend Start SERVICE_AUTO_START
nssm set AimsBackend Description "AIMS POS backend (Node/Express)"

$pythonVenv = Join-Path $RepoRoot "ai-service\venv\Scripts\python.exe"
$aiServiceDir = Join-Path $RepoRoot "ai-service"
$aiServiceLogDir = Join-Path $aiServiceDir "logs"
New-Item -ItemType Directory -Force -Path $aiServiceLogDir | Out-Null

Write-Host "Installing AimsAiService service..."
# --host 127.0.0.1: loopback only, since the backend reaches this over localhost (both run on the
# same store server PC) and it must never be reachable from the LAN or internet directly.
nssm install AimsAiService $pythonVenv "-m uvicorn main:app --host 127.0.0.1 --port 8000"
nssm set AimsAiService AppDirectory $aiServiceDir
nssm set AimsAiService AppEnvironmentExtra "NODE_ENV=production"
nssm set AimsAiService AppStdout (Join-Path $aiServiceLogDir "ai-service.log")
nssm set AimsAiService AppStderr (Join-Path $aiServiceLogDir "ai-service.log")
nssm set AimsAiService AppRotateFiles 1
nssm set AimsAiService AppRotateOnline 1
nssm set AimsAiService AppRotateBytes 10485760
nssm set AimsAiService AppRestartDelay 3000
nssm set AimsAiService Start SERVICE_AUTO_START
nssm set AimsAiService Description "AIMS AI forecasting microservice (FastAPI/uvicorn)"

Write-Host ""
Write-Host "Both services are installed but not started yet, so you can double-check backend/.env"
Write-Host "and ai-service/.env first. Start the AI service before the backend (the backend still"
Write-Host "works without it via its built-in fallback engine, but starting it first avoids the"
Write-Host "backend's first few requests hitting that fallback needlessly):"
Write-Host "  nssm start AimsAiService"
Write-Host "  nssm start AimsBackend"
Write-Host ""
Write-Host "Manage them with services.msc, or: nssm status <name> / nssm stop <name> / nssm restart <name>"
