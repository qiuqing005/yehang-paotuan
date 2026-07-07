param(
  [Parameter(Mandatory = $true)]
  [string]$HostName,

  [string]$User = "root",
  [int]$Port = 22,
  [string]$Container = "paotuan-web-1",
  [string]$Image = "paotuan-web:latest",
  [switch]$SkipBuild
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

if (-not $SkipBuild) {
  npm --workspace apps/web run build
}

$distDir = Join-Path (Get-Location) "apps/web/dist"
if (-not (Test-Path -LiteralPath $distDir)) {
  throw "Web dist not found: $distDir"
}

$stamp = Get-Date -Format "yyyyMMddHHmmss"
$archive = Join-Path $env:TEMP "paotuan-web-dist-$stamp.tgz"
$remote = "$User@$HostName"
$remoteArchive = "/tmp/paotuan-web-dist-$stamp.tgz"
$remoteDir = "/tmp/paotuan-web-dist-$stamp"
$sshOptions = @("-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new")

if (Test-Path -LiteralPath $archive) {
  Remove-Item -LiteralPath $archive -Force
}

try {
  tar -czf $archive -C $distDir .
  scp @sshOptions -P $Port $archive "${remote}:$remoteArchive"
  ssh @sshOptions -p $Port $remote "set -e; rm -rf '$remoteDir'; mkdir -p '$remoteDir'; tar -xzf '$remoteArchive' -C '$remoteDir'; docker exec '$Container' sh -lc 'rm -rf /usr/share/caddy/*'; docker cp '$remoteDir/.' '${Container}:/usr/share/caddy/'; docker restart '$Container' >/dev/null; docker commit '$Container' '$Image' >/dev/null; rm -rf '$remoteDir' '$remoteArchive'"
  Write-Output "Web dist deployed to ${remote}:${Container}"
} finally {
  if (Test-Path -LiteralPath $archive) {
    Remove-Item -LiteralPath $archive -Force
  }
}
