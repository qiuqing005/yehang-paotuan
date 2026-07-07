param(
  [string]$Version = "0.2.8",
  [int]$VersionCode = 12,
  [string]$ApiBase = "http://localhost:8787"
)

$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

function Assert-InWorkspace {
  param([string]$Path)
  $full = [System.IO.Path]::GetFullPath($Path)
  if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to touch path outside workspace: $full"
  }
  return $full
}

function Sync-Directory {
  param(
    [string]$Source,
    [string]$Target
  )

  $sourceFull = Assert-InWorkspace $Source
  $targetFull = Assert-InWorkspace $Target
  if (-not (Test-Path -LiteralPath $sourceFull -PathType Container)) {
    throw "Source directory does not exist: $sourceFull"
  }

  New-Item -ItemType Directory -Force -Path $targetFull | Out-Null
  Get-ChildItem -LiteralPath $targetFull -Force | Remove-Item -Recurse -Force
  Copy-Item -Path (Join-Path $sourceFull "*") -Destination $targetFull -Recurse -Force
}

function Update-TextFile {
  param(
    [string]$Path,
    [scriptblock]$Transform
  )

  $full = Assert-InWorkspace $Path
  $text = [System.IO.File]::ReadAllText($full)
  $updated = & $Transform $text
  [System.IO.File]::WriteAllText($full, $updated)
}

function Validate-WebBundle {
  param([string]$Target)

  $targetFull = Assert-InWorkspace $Target
  $indexPath = Join-Path $targetFull "index.html"
  if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf)) {
    throw "Native bundle missing index.html: $indexPath"
  }

  $html = [System.IO.File]::ReadAllText($indexPath)
  $matches = [regex]::Matches($html, '(?:src|href)="([^":#?]+)(?:[?#][^"]*)?"')
  foreach ($match in $matches) {
    $assetPath = $match.Groups[1].Value.TrimStart("/")
    if (-not $assetPath -or $assetPath.StartsWith("data:", [System.StringComparison]::OrdinalIgnoreCase)) {
      continue
    }
    $fullAssetPath = Join-Path $targetFull $assetPath
    if (-not (Test-Path -LiteralPath $fullAssetPath -PathType Leaf)) {
      throw "Native bundle index references missing asset: $fullAssetPath"
    }
  }

  $assetDir = Join-Path $targetFull "assets"
  if (-not (Test-Path -LiteralPath $assetDir -PathType Container)) {
    throw "Native bundle missing assets directory: $assetDir"
  }
  if (-not (Get-ChildItem -LiteralPath $assetDir -Filter "*.js" -File | Select-Object -First 1)) {
    throw "Native bundle missing compiled JavaScript assets: $assetDir"
  }
  if (-not (Get-ChildItem -LiteralPath $assetDir -Filter "*.css" -File | Select-Object -First 1)) {
    throw "Native bundle missing compiled CSS assets: $assetDir"
  }
}

function Write-NativeRuntimeConfig {
  param([string]$Target)

  $targetFull = Assert-InWorkspace $Target
  $normalizedApiBase = $ApiBase.TrimEnd("/")
  if (-not $normalizedApiBase) {
    throw "ApiBase cannot be empty for native packages."
  }
  $js = "window.__PAOTUAN_API_BASE__ = " + (ConvertTo-Json $normalizedApiBase -Compress) + ";"
  [System.IO.File]::WriteAllText((Join-Path $targetFull "native-config.js"), $js)
}

$webDist = Join-Path $root "apps/web/dist"
$windowsDir = Join-Path $root "apps/native/windows-electron"
$androidDir = Join-Path $root "apps/native/android-webview"

Sync-Directory -Source $webDist -Target (Join-Path $windowsDir "renderer")
Sync-Directory -Source $webDist -Target (Join-Path $androidDir "app/src/main/assets/www")
Write-NativeRuntimeConfig -Target (Join-Path $windowsDir "renderer")
Write-NativeRuntimeConfig -Target (Join-Path $androidDir "app/src/main/assets/www")
Validate-WebBundle -Target (Join-Path $windowsDir "renderer")
Validate-WebBundle -Target (Join-Path $androidDir "app/src/main/assets/www")

Copy-Item -LiteralPath (Assert-InWorkspace (Join-Path $root "main.js")) -Destination (Assert-InWorkspace (Join-Path $windowsDir "main.js")) -Force
$normalizedApiBase = $ApiBase.TrimEnd("/")
Update-TextFile -Path (Join-Path $windowsDir "main.js") -Transform {
  param($text)
  $jsonApiBase = ConvertTo-Json $normalizedApiBase -Compress
  $text -replace 'const DEFAULT_APP_URL = ".*?";', "const DEFAULT_APP_URL = $jsonApiBase;"
}
$runtimeConfig = @{
  apiBase = $normalizedApiBase
  appUrl = $normalizedApiBase
} | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText((Assert-InWorkspace (Join-Path $windowsDir "native-runtime.json")), $runtimeConfig)

Update-TextFile -Path (Join-Path $windowsDir "package.json") -Transform {
  param($text)
  $data = $text | ConvertFrom-Json
  $data.version = $Version
  $files = @($data.build.files)
  if (-not ($files -contains "native-runtime.json")) {
    $data.build.files = @("main.js", "native-runtime.json", "package.json", "renderer/**")
  }
  $data | ConvertTo-Json -Depth 20
}

Update-TextFile -Path (Join-Path $androidDir "app/build.gradle") -Transform {
  param($text)
  $text = $text -replace 'versionCode\s+\d+', "versionCode $VersionCode"
  $text -replace 'versionName\s+"[^"]+"', "versionName `"$Version`""
}

Write-Host "Native assets synced for version $Version (Android versionCode $VersionCode, API $($ApiBase.TrimEnd('/')))."
