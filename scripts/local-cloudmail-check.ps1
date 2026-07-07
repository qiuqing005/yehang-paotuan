param(
  [int]$ServerPort = 8790,
  [int]$WebPort = 5174,
  [string]$EmailDomain = "example.com",
  [string]$CloudMailBaseUrl = "https://mail.example.com",
  [string]$ScreenshotPrefix = "cloudmail-local",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

function Require-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

function Test-PortFree($Port) {
  -not (Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Wait-HttpOk($Url, $Name, $Process = $null, $StdoutPath = $null, $StderrPath = $null) {
  $deadline = (Get-Date).AddSeconds(40)
  do {
    if ($null -ne $Process -and $Process.HasExited) {
      throw "$Name process exited early with code $($Process.ExitCode)"
    }
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        return
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $deadline)

  $details = @()
  if ($StdoutPath -and (Test-Path -LiteralPath $StdoutPath)) {
    $details += "stdout:"
    $details += (Get-Content -LiteralPath $StdoutPath -Tail 20)
  }
  if ($StderrPath -and (Test-Path -LiteralPath $StderrPath)) {
    $details += "stderr:"
    $details += (Get-Content -LiteralPath $StderrPath -Tail 20)
  }
  if ($details.Count -gt 0) {
    throw "$Name did not become ready: $Url`n$($details -join "`n")"
  }

  throw "$Name did not become ready: $Url"
}

function Join-ProcessArguments([string[]]$Arguments) {
  ($Arguments | ForEach-Object {
    $argument = [string]$_
    if ($argument -match '[\s"]') {
      '"' + ($argument -replace '"', '\"') + '"'
    } else {
      $argument
    }
  }) -join " "
}

function Start-NodeProcess($FileName, [string[]]$Arguments, $Environment) {
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $FileName
  $startInfo.Arguments = Join-ProcessArguments $Arguments
  $startInfo.WorkingDirectory = (Get-Location).Path
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true

  foreach ($key in $Environment.Keys) {
    $startInfo.Environment[$key] = [string]$Environment[$key]
  }

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  [void]$process.Start()
  return $process
}

Require-Command "node"
Require-Command "npm"

$cloudMailEmail = $env:CLOUD_MAIL_EMAIL
$cloudMailPassword = $env:CLOUD_MAIL_PASSWORD
$cloudMailToken = $env:CLOUD_MAIL_TOKEN
if (-not $cloudMailToken -and (-not $cloudMailEmail -or -not $cloudMailPassword)) {
  throw "Set CLOUD_MAIL_EMAIL and CLOUD_MAIL_PASSWORD, or set CLOUD_MAIL_TOKEN, before running this script."
}

if (-not (Test-PortFree $ServerPort)) {
  throw "Port $ServerPort is already in use."
}
if (-not (Test-PortFree $WebPort)) {
  throw "Port $WebPort is already in use."
}

if (-not $SkipBuild) {
  npm run build
}

$runId = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$dataDir = Join-Path $env:TEMP "paotuan-cloudmail-$runId"
$logDir = Join-Path (Get-Location) "output\logs"
New-Item -ItemType Directory -Force -Path $dataDir, $logDir | Out-Null

$webOut = Join-Path $logDir "local-cloudmail-web-$runId.out.log"
$webErr = Join-Path $logDir "local-cloudmail-web-$runId.err.log"

$defaultCloudMailFromName = "Paotuan"
if ($env:CLOUD_MAIL_FROM_NAME) {
  $defaultCloudMailFromName = $env:CLOUD_MAIL_FROM_NAME
}

$defaultCloudMailTimeoutMs = "10000"
if ($env:CLOUD_MAIL_TIMEOUT_MS) {
  $defaultCloudMailTimeoutMs = $env:CLOUD_MAIL_TIMEOUT_MS
}

$server = $null
$web = $null

try {
  $serverEnv = @{
    NODE_ENV = "production"
    PORT = $ServerPort
    DATA_DIR = $dataDir
    VERIFICATION_CODE_SECRET = "local-cloudmail-verification-secret-$runId"
    EMAIL_DELIVERY_MODE = ""
    EMAIL_DEBUG_CODE = "false"
    CLOUD_MAIL_BASE_URL = $CloudMailBaseUrl
    CLOUD_MAIL_EMAIL = $cloudMailEmail
    CLOUD_MAIL_PASSWORD = $cloudMailPassword
    CLOUD_MAIL_TOKEN = $cloudMailToken
    CLOUD_MAIL_ACCOUNT_ID = $env:CLOUD_MAIL_ACCOUNT_ID
    CLOUD_MAIL_FROM = $env:CLOUD_MAIL_FROM
    CLOUD_MAIL_FROM_NAME = $defaultCloudMailFromName
    CLOUD_MAIL_TIMEOUT_MS = $defaultCloudMailTimeoutMs
  }

  $server = Start-NodeProcess "node" @("apps/server/dist/index.js") $serverEnv
  Wait-HttpOk "http://127.0.0.1:$ServerPort/health" "server"

  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$ServerPort/health"
  if ($health.ok -ne $true -or $health.service -ne "paotuan-server") {
    throw "Server health check failed: $($health | ConvertTo-Json -Compress)"
  }

  $vitePath = Join-Path (Get-Location) "node_modules\vite\bin\vite.js"
  $webWorkingDirectory = Join-Path (Get-Location) "apps\web"
  $web = Start-Process -FilePath "node" -ArgumentList @($vitePath, "--host", "127.0.0.1", "--port", "$WebPort") -WorkingDirectory $webWorkingDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput $webOut -RedirectStandardError $webErr
  Wait-HttpOk "http://127.0.0.1:$WebPort/site.webmanifest" "web" $web $webOut $webErr

  $oldEnv = @{}
  $keys = @(
    "SMOKE_REQUIRE_CLOUD_MAIL",
    "SMOKE_EMAIL_DOMAIN",
    "SMOKE_CLOUD_MAIL_BASE_URL",
    "SMOKE_CLOUD_MAIL_EMAIL",
    "SMOKE_CLOUD_MAIL_PASSWORD",
    "SMOKE_CLOUD_MAIL_TOKEN",
    "SMOKE_BACKEND_URL",
    "SMOKE_FRONTEND_URL",
    "UI_CHECK_FRONTEND_URL",
    "UI_CHECK_API_BASE",
    "UI_CHECK_EMAIL_DOMAIN",
    "UI_CHECK_CLOUD_MAIL_BASE_URL",
    "UI_CHECK_CLOUD_MAIL_EMAIL",
    "UI_CHECK_CLOUD_MAIL_PASSWORD",
    "UI_CHECK_CLOUD_MAIL_TOKEN",
    "UI_CHECK_SCREENSHOT_PREFIX"
  )
  foreach ($key in $keys) {
    $oldEnv[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
  }

  try {
    $env:SMOKE_REQUIRE_CLOUD_MAIL = "true"
    $env:SMOKE_EMAIL_DOMAIN = $EmailDomain
    $env:SMOKE_CLOUD_MAIL_BASE_URL = $CloudMailBaseUrl
    $env:SMOKE_CLOUD_MAIL_EMAIL = $cloudMailEmail
    $env:SMOKE_CLOUD_MAIL_PASSWORD = $cloudMailPassword
    $env:SMOKE_CLOUD_MAIL_TOKEN = $cloudMailToken
    $env:SMOKE_BACKEND_URL = "http://127.0.0.1:$ServerPort"
    $env:SMOKE_FRONTEND_URL = "http://127.0.0.1:$WebPort"
    npm run smoke

    $env:UI_CHECK_FRONTEND_URL = "http://127.0.0.1:$WebPort"
    $env:UI_CHECK_API_BASE = "http://127.0.0.1:$ServerPort"
    $env:UI_CHECK_EMAIL_DOMAIN = $EmailDomain
    $env:UI_CHECK_CLOUD_MAIL_BASE_URL = $CloudMailBaseUrl
    $env:UI_CHECK_CLOUD_MAIL_EMAIL = $cloudMailEmail
    $env:UI_CHECK_CLOUD_MAIL_PASSWORD = $cloudMailPassword
    $env:UI_CHECK_CLOUD_MAIL_TOKEN = $cloudMailToken
    $env:UI_CHECK_SCREENSHOT_PREFIX = $ScreenshotPrefix
    npm run ui:remote
  } finally {
    foreach ($key in $keys) {
      [Environment]::SetEnvironmentVariable($key, $oldEnv[$key], "Process")
    }
  }

  Write-Output "Local Cloud Mail check passed."
} finally {
  if ($null -ne $web -and -not $web.HasExited) {
    Stop-Process -Id $web.Id -Force
  }
  if ($null -ne $server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -Force
  }
}
