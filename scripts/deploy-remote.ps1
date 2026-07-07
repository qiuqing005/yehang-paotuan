param(
  [Parameter(Mandatory = $true)]
  [string]$HostName,

  [string]$User = "root",
  [int]$Port = 22,
  [string]$RemoteDir = "/opt/paotuan",
  [string]$EnvFile = "",
  [switch]$HttpOnly,
  [switch]$SkipLocalChecks
)

$ErrorActionPreference = "Stop"

function Require-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

Require-Command "ssh"
Require-Command "scp"
Require-Command "tar"

if (-not $SkipLocalChecks) {
  npm run build
  npm run test
}

$stamp = Get-Date -Format "yyyyMMddHHmmss"
$archive = Join-Path $env:TEMP "paotuan-$stamp.tgz"
$envUploadFile = $null
$remote = "$User@$HostName"
$releaseDir = "$RemoteDir/releases/$stamp"

if (Test-Path -LiteralPath $archive) {
  Remove-Item -LiteralPath $archive -Force
}

tar `
  --exclude="./node_modules" `
  --exclude="./output" `
  --exclude="./apps/server/data" `
  --exclude="./apps/server/dist" `
  --exclude="./apps/web/dist" `
  -czf $archive .

ssh -p $Port $remote "set -e; mkdir -p '$RemoteDir/releases' '$releaseDir'; if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sh; fi"
scp -P $Port $archive "${remote}:$releaseDir/source.tgz"
ssh -p $Port $remote "set -e; cd '$releaseDir'; tar -xzf source.tgz; rm source.tgz; if [ -f '$RemoteDir/current/deploy/.env' ] && [ ! -f deploy/.env ]; then cp '$RemoteDir/current/deploy/.env' deploy/.env; fi; ln -sfn '$releaseDir' '$RemoteDir/current'"

if ($EnvFile -ne "") {
  if (-not (Test-Path -LiteralPath $EnvFile)) {
    throw "Env file not found: $EnvFile"
  }

  $envUploadFile = Join-Path $env:TEMP "paotuan-env-$stamp.env"
  $envContent = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $EnvFile))
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($envUploadFile, $envContent, $utf8NoBom)

  scp -P $Port $envUploadFile "${remote}:$RemoteDir/current/deploy/.env"
}

$composeFiles = if ($HttpOnly) { "-f docker-compose.yml -f docker-compose.http.yml" } else { "-f docker-compose.yml" }

ssh -p $Port $remote "set -e; cd '$RemoteDir/current/deploy'; if [ ! -f .env ]; then cp .env.example .env; echo 'Created deploy/.env from example. Edit it and rerun this script.'; exit 2; fi; docker compose --env-file .env $composeFiles config >/dev/null; docker compose --env-file .env $composeFiles up -d --build; docker compose --env-file .env $composeFiles ps"

Remove-Item -LiteralPath $archive -Force
if ($null -ne $envUploadFile -and (Test-Path -LiteralPath $envUploadFile)) {
  Remove-Item -LiteralPath $envUploadFile -Force
}
Write-Output "Deployment command completed for ${remote}:$RemoteDir/current"
