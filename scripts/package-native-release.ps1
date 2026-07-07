param(
  [string]$Version = "0.2.8",
  [int]$VersionCode = 12,
  [string]$ApiBase = "http://localhost:8787",
  [string]$PackageRepository = $env:PAOTUAN_PACKAGE_REPOSITORY
)

$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$webDist = Join-Path $root "apps/web/dist"
$windowsDir = Join-Path $root "apps/native/windows-electron"
$androidDir = Join-Path $root "apps/native/android-webview"
$localAndroidSdkDir = Join-Path $root "output/native-build/android-sdk"
$bundledGradleBat = Join-Path $root "output/native-build/gradle/gradle-8.9/bin/gradle.bat"
$gradleHome = Join-Path $root "output/native-build/gradle-home"
$packageDir = Join-Path $root "output/packages"
$packageMirrorDir = if ($env:PAOTUAN_PACKAGE_MIRROR_DIR) {
  [System.IO.Path]::GetFullPath($env:PAOTUAN_PACKAGE_MIRROR_DIR)
} else {
  Join-Path $root "output/package-mirror"
}
$packageMirrorPackageDir = Join-Path $packageMirrorDir "packages"

function Assert-InWorkspace {
  param([string]$Path)
  $full = [System.IO.Path]::GetFullPath($Path)
  if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to touch path outside workspace: $full"
  }
  return $full
}

function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Action
  )
  Write-Host ""
  Write-Host "==> $Name"
  & $Action
}

function Resolve-CommandPath {
  param([string]$CommandPath)
  if ($CommandPath -eq "java" -and $env:JAVA_HOME) {
    $javaExe = Join-Path $env:JAVA_HOME "bin/java.exe"
    if (Test-Path -LiteralPath $javaExe -PathType Leaf) {
      return $javaExe
    }
  }
  if ($CommandPath -eq "npm") {
    $npm = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
    if ($npm) {
      return $npm.Source
    }
  }
  if ($CommandPath -eq "powershell") {
    $powershell = Get-Command "powershell.exe" -ErrorAction SilentlyContinue
    if ($powershell) {
      return $powershell.Source
    }
  }
  $command = Get-Command $CommandPath -ErrorAction SilentlyContinue
  if ($command -and $command.Source) {
    return $command.Source
  }
  return $CommandPath
}

function Resolve-AndroidSdkDir {
  $candidates = @(
    $localAndroidSdkDir,
    $env:ANDROID_HOME,
    $env:ANDROID_SDK_ROOT
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Container)) {
      return [System.IO.Path]::GetFullPath($candidate)
    }
  }
  throw "Android SDK not found. Set ANDROID_HOME or ANDROID_SDK_ROOT, or install the local SDK under output/native-build/android-sdk."
}

function Resolve-GradleCommand {
  if (Test-Path -LiteralPath $bundledGradleBat -PathType Leaf) {
    return $bundledGradleBat
  }
  $gradle = Get-Command "gradle.bat" -ErrorAction SilentlyContinue
  if ($gradle -and $gradle.Source) {
    return $gradle.Source
  }
  $gradle = Get-Command "gradle" -ErrorAction SilentlyContinue
  if ($gradle -and $gradle.Source) {
    return $gradle.Source
  }
  throw "Gradle not found. Install Gradle or place the project-local distribution under output/native-build/gradle/gradle-8.9."
}

function ConvertTo-CmdArgument {
  param([string]$Value)
  if ($Value -match '^[A-Za-z0-9_./:=+\-\\]+$') {
    return $Value
  }
  return '"' + ($Value -replace '"', '\"') + '"'
}

function Invoke-NativeCommand {
  param(
    [string]$CommandPath,
    [string[]]$CommandArgs,
    [string]$WorkingDirectory = $root
  )
  $resolvedCommand = Resolve-CommandPath $CommandPath
  Write-Host "Running: $resolvedCommand $($CommandArgs -join ' ')"
  Push-Location -LiteralPath $WorkingDirectory
  try {
    & $resolvedCommand @CommandArgs
    if ($LASTEXITCODE -ne 0) {
      throw "$resolvedCommand failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Use-PreferredJdk {
  $candidates = @(
    "C:\Program Files\Java\jdk-21",
    "C:\Program Files\Java\jdk-17",
    $env:JAVA_HOME
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate "bin/java.exe") -PathType Leaf)) {
      $env:JAVA_HOME = $candidate
      $env:Path = "$candidate\bin;$env:Path"
      return
    }
  }
}

function Ensure-AndroidSigningEnv {
  $keys = @(
    "PAOTUAN_ANDROID_KEYSTORE",
    "PAOTUAN_ANDROID_KEYSTORE_PASSWORD",
    "PAOTUAN_ANDROID_KEY_ALIAS",
    "PAOTUAN_ANDROID_KEY_PASSWORD"
  )
  $configured = $keys | Where-Object { [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_)) -eq $false }
  if ($configured.Count -eq $keys.Count) {
    return
  }
  if ($configured.Count -gt 0) {
    throw "Android signing env is partially configured. Set all PAOTUAN_ANDROID_* variables or none."
  }

  $localKey = Join-Path $androidDir "keystore/yehang-paotuan-v022-release.jks"
  $localPass = Join-Path $androidDir "keystore/yehang-paotuan-v022-release.pass"
  if (-not (Test-Path -LiteralPath $localKey -PathType Leaf) -or -not (Test-Path -LiteralPath $localPass -PathType Leaf)) {
    $localKey = Join-Path $root "output/native-build/android-webview/keystore/yehang-paotuan-v022-release.jks"
    $localPass = Join-Path $root "output/native-build/android-webview/keystore/yehang-paotuan-v022-release.pass"
  }
  if (-not (Test-Path -LiteralPath $localKey -PathType Leaf) -or -not (Test-Path -LiteralPath $localPass -PathType Leaf)) {
    throw "Android release signing material is missing. Cannot build a user-installable release APK."
  }

  $password = (Get-Content -LiteralPath $localPass -Encoding UTF8 -Raw).Trim()
  $env:PAOTUAN_ANDROID_KEYSTORE = $localKey
  $env:PAOTUAN_ANDROID_KEYSTORE_PASSWORD = $password
  $env:PAOTUAN_ANDROID_KEY_ALIAS = "yehang-paotuan"
  $env:PAOTUAN_ANDROID_KEY_PASSWORD = $password
}

function Resolve-AndroidTool {
  param([string]$Name)
  $androidSdkDir = Resolve-AndroidSdkDir
  $tools = Get-ChildItem -LiteralPath (Join-Path $androidSdkDir "build-tools") -Recurse -File -Filter $Name -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending
  if (-not $tools) {
    throw "Android build tool not found: $Name"
  }
  return $tools[0].FullName
}

function New-SubstDrive {
  foreach ($code in 80..90) {
    $letter = [char]$code
    $drive = "$letter`:"
    if (Get-PSDrive -Name $letter -PSProvider FileSystem -ErrorAction SilentlyContinue) {
      continue
    }
    if ((cmd.exe /c subst) | Select-String -SimpleMatch "$drive\") {
      continue
    }
    cmd.exe /c "subst $drive `"$root`"" | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to create temporary subst drive $drive for $root"
    }
    return $drive
  }
  throw "No free drive letter is available for temporary subst mapping."
}

function Remove-SubstDrive {
  param([string]$Drive)
  if ($Drive) {
    cmd.exe /c "subst $Drive /D" | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to remove temporary subst drive $Drive"
    }
  }
}

function Assert-ApkAssets {
  param([string]$ApkPath)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($ApkPath)
  try {
    foreach ($required in @(
      "assets/www/index.html",
      "assets/www/native-config.js",
      "assets/www/site.webmanifest"
    )) {
      if (-not $zip.GetEntry($required)) {
        throw "Missing APK asset: $required"
      }
    }
    if (-not ($zip.Entries | Where-Object { $_.FullName -match '^assets/www/assets/.+\.js$' } | Select-Object -First 1)) {
      throw "Missing APK JavaScript asset."
    }
    if (-not ($zip.Entries | Where-Object { $_.FullName -match '^assets/www/assets/.+\.css$' } | Select-Object -First 1)) {
      throw "Missing APK CSS asset."
    }
  } finally {
    $zip.Dispose()
  }
}

function Get-BundleAssetRefsFromHtml {
  param([string]$Html)
  $matches = [regex]::Matches($Html, '(?:src|href)="([^":#?]+)(?:[?#][^"]*)?"')
  $refs = @()
  foreach ($match in $matches) {
    $ref = $match.Groups[1].Value.TrimStart("/", ".")
    if ($ref -match '^assets/.+\.(js|css)$') {
      $refs += $ref
    }
  }
  return $refs | Sort-Object
}

function Get-WebDistManifest {
  $webDistFull = Assert-InWorkspace $webDist
  $manifest = @{}
  Get-ChildItem -LiteralPath $webDistFull -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($webDistFull.Length).TrimStart("\", "/") -replace "\\", "/"
    if ($relative -eq "native-config.js") {
      return
    }
    $manifest[$relative] = @{
      hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
      size = $_.Length
    }
  }
  return $manifest
}

function Convert-ManifestToLines {
  param([hashtable]$Manifest)
  return $Manifest.Keys | Sort-Object | ForEach-Object {
    "$_|$($Manifest[$_].size)|$($Manifest[$_].hash)"
  }
}

function Assert-BundleManifestMatches {
  param(
    [string]$Label,
    [hashtable]$Actual
  )
  $expected = Get-WebDistManifest
  $expectedLines = Convert-ManifestToLines $expected
  $actualLines = Convert-ManifestToLines $Actual
  $expectedText = $expectedLines -join "`n"
  $actualText = $actualLines -join "`n"
  if ($expectedText -ne $actualText) {
    throw "$Label bundle content differs from apps/web/dist.`nExpected:`n$expectedText`nActual:`n$actualText"
  }
}

function Assert-BundleAssetRefsMatch {
  param(
    [string]$Label,
    [string]$Html
  )
  $expectedHtml = [System.IO.File]::ReadAllText((Join-Path (Assert-InWorkspace $webDist) "index.html"))
  $expectedRefs = Get-BundleAssetRefsFromHtml $expectedHtml
  $actualRefs = Get-BundleAssetRefsFromHtml $Html
  $expectedText = $expectedRefs -join "`n"
  $actualText = $actualRefs -join "`n"
  if ($expectedText -ne $actualText) {
    throw "$Label index asset references differ from apps/web/dist.`nExpected:`n$expectedText`nActual:`n$actualText"
  }
}

function Get-StreamSha256 {
  param([System.IO.Stream]$Stream)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash($Stream)
    return ([System.BitConverter]::ToString($bytes) -replace "-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Read-ZipEntryText {
  param([System.IO.Compression.ZipArchiveEntry]$Entry)
  $stream = $Entry.Open()
  try {
    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8)
    try {
      return $reader.ReadToEnd()
    } finally {
      $reader.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Assert-ApkWebBundleMatchesDist {
  param([string]$ApkPath)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($ApkPath)
  try {
    $prefix = "assets/www/"
    $manifest = @{}
    foreach ($entry in $zip.Entries) {
      if (-not $entry.FullName.StartsWith($prefix, [System.StringComparison]::Ordinal) -or $entry.FullName.EndsWith("/")) {
        continue
      }
      $relative = $entry.FullName.Substring($prefix.Length)
      if ($relative -eq "native-config.js") {
        continue
      }
      $stream = $entry.Open()
      try {
        $manifest[$relative] = @{
          hash = Get-StreamSha256 $stream
          size = $entry.Length
        }
      } finally {
        $stream.Dispose()
      }
    }
    Assert-BundleManifestMatches -Label "APK assets/www" -Actual $manifest

    $index = $zip.GetEntry("assets/www/index.html")
    if (-not $index) {
      throw "APK missing assets/www/index.html"
    }
    Assert-BundleAssetRefsMatch -Label "APK assets/www/index.html" -Html (Read-ZipEntryText $index)
  } finally {
    $zip.Dispose()
  }
}

function Invoke-AaptBadging {
  param([string]$ApkPath)
  $aapt = Resolve-AndroidTool "aapt.exe"
  $drive = New-SubstDrive
  try {
    $rootPrefix = $root.TrimEnd("\", "/")
    if ($ApkPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      $relativeApk = $ApkPath.Substring($rootPrefix.Length).TrimStart("\", "/")
      $asciiApk = Join-Path "$drive\" $relativeApk
    } else {
      $asciiApk = $ApkPath
    }
    if ($aapt.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      $relativeAapt = $aapt.Substring($rootPrefix.Length).TrimStart("\", "/")
      $asciiAapt = Join-Path "$drive\" $relativeAapt
    } else {
      $asciiAapt = $aapt
    }
    & $asciiAapt dump badging $asciiApk
    if ($LASTEXITCODE -ne 0) {
      throw "aapt dump badging failed with exit code $LASTEXITCODE"
    }
  } finally {
    Remove-SubstDrive $drive
  }
}

function Ensure-WindowsDependencies {
  $nodeModules = Join-Path $windowsDir "node_modules"
  if (Test-Path -LiteralPath $nodeModules -PathType Container) {
    return
  }
  Invoke-NativeCommand -CommandPath "npm" -CommandArgs @("install") -WorkingDirectory $windowsDir
}

function Assert-Apk {
  param([string]$ApkPath)
  $apksignerJar = Resolve-AndroidTool "apksigner.jar"
  Invoke-NativeCommand -CommandPath "java" -CommandArgs @("-jar", $apksignerJar, "verify", "--verbose", "--print-certs", $ApkPath)
  $badging = Invoke-AaptBadging -ApkPath $ApkPath
  $badgingText = $badging -join "`n"
  if ($badgingText -notmatch "package: name='com\.yehang\.paotuan'") {
    throw "APK package name check failed."
  }
  if ($badgingText -notmatch "versionCode='$VersionCode'") {
    throw "APK versionCode check failed."
  }
  if ($badgingText -notmatch "versionName='$([regex]::Escape($Version))'") {
    throw "APK versionName check failed."
  }
  foreach ($permission in @("android.permission.INTERNET", "android.permission.RECORD_AUDIO")) {
    if ($badgingText -notmatch [regex]::Escape($permission)) {
      throw "APK permission missing: $permission"
    }
  }
  Assert-ApkAssets -ApkPath $ApkPath
  Assert-ApkWebBundleMatchesDist -ApkPath $ApkPath
}

function Assert-WindowsAsar {
  Push-Location -LiteralPath $windowsDir
  try {
    $script = @'
const asar = require('@electron/asar');
const entries = new Set(asar.listPackage('dist/win-unpacked/resources/app.asar').map((entry) => entry.replace(/\\/g, '/')));
for (const required of ['/main.js', '/native-runtime.json', '/renderer/index.html']) {
  if (!entries.has(required)) {
    throw new Error(`Missing from app.asar: ${required}`);
  }
}
'@
    node -e $script
    if ($LASTEXITCODE -ne 0) {
      throw "Electron asar validation failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Assert-WindowsAsarWebBundleMatchesDist {
  $asarPath = Join-Path $windowsDir "dist/win-unpacked/resources/app.asar"
  $env:PAOTUAN_WEB_DIST = (Assert-InWorkspace $webDist)
  $env:PAOTUAN_ASAR_PATH = (Assert-InWorkspace $asarPath)
  Push-Location -LiteralPath $windowsDir
  try {
    $script = @'
const asar = require('@electron/asar');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const webDist = process.env.PAOTUAN_WEB_DIST;
const asarPath = process.env.PAOTUAN_ASAR_PATH;

function fail(message) {
  throw new Error(message);
}

function normalize(entry) {
  return entry.replace(/\\/g, '/').replace(/^\/+/, '');
}

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listFiles(absolute, base);
    }
    if (!entry.isFile()) {
      return [];
    }
    return normalize(path.relative(base, absolute));
  }).sort();
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hashFile(filePath) {
  return hashBuffer(fs.readFileSync(filePath));
}

function readAssetRefs(html) {
  return [...html.matchAll(/(?:src|href)="([^":#?]+)(?:[?#][^"]*)?"/g)]
    .map((match) => normalize(match[1]))
    .filter((ref) => /^assets\/.+\.(?:js|css)$/.test(ref))
    .sort();
}

function expectedManifest() {
  return new Map(
    listFiles(webDist)
      .filter((relativePath) => relativePath !== 'native-config.js')
      .map((relativePath) => {
        const absolute = path.join(webDist, ...relativePath.split('/'));
        const stat = fs.statSync(absolute);
        return [relativePath, { hash: hashFile(absolute), size: stat.size }];
      }),
  );
}

function extractAsarFile(relativePath) {
  return asar.extractFile(asarPath, path.join('renderer', ...relativePath.split('/')));
}

function isAsarFile(relativePath) {
  try {
    const stat = asar.statFile(asarPath, path.join('renderer', ...relativePath.split('/')));
    return !stat.files;
  } catch {
    return false;
  }
}

function actualManifest() {
  return new Map(
    asar.listPackage(asarPath)
      .map(normalize)
      .filter((entry) => entry.startsWith('renderer/') && !entry.endsWith('/'))
      .map((entry) => entry.slice('renderer/'.length))
      .filter((relativePath) => relativePath && relativePath !== 'native-config.js')
      .filter(isAsarFile)
      .sort()
      .map((relativePath) => {
        const buffer = extractAsarFile(relativePath);
        return [relativePath, { hash: hashBuffer(buffer), size: buffer.length }];
      }),
  );
}

function manifestLines(manifest) {
  return [...manifest.keys()].sort().map((key) => `${key}|${manifest.get(key).size}|${manifest.get(key).hash}`);
}

const expected = expectedManifest();
const actual = actualManifest();
const expectedText = manifestLines(expected).join('\n');
const actualText = manifestLines(actual).join('\n');
if (expectedText !== actualText) {
  fail(`Windows app.asar renderer differs from apps/web/dist.\nExpected:\n${expectedText}\nActual:\n${actualText}`);
}

const expectedRefs = readAssetRefs(fs.readFileSync(path.join(webDist, 'index.html'), 'utf8')).join('\n');
const actualRefs = readAssetRefs(extractAsarFile('index.html').toString('utf8')).join('\n');
if (expectedRefs !== actualRefs) {
  fail(`Windows app.asar renderer index asset references differ from apps/web/dist.\nExpected:\n${expectedRefs}\nActual:\n${actualRefs}`);
}
'@
    node -e $script
    if ($LASTEXITCODE -ne 0) {
      throw "Electron asar web bundle validation failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Format-SizeMb {
  param([long]$Bytes)
  return ([Math]::Round($Bytes / 1MB, 2)).ToString("0.##", [System.Globalization.CultureInfo]::InvariantCulture)
}

function Publish-Packages {
  param(
    [string]$ApkPath,
    [string]$ExePath
  )
  New-Item -ItemType Directory -Force -Path (Assert-InWorkspace $packageDir), (Assert-InWorkspace $packageMirrorPackageDir) | Out-Null

  $apkName = "yehang-paotuan-android-v$Version.apk"
  $exeName = "yehang-paotuan-windows-v$Version.exe"
  $apkTargets = @(
    (Join-Path $packageDir $apkName),
    (Join-Path $packageMirrorPackageDir $apkName)
  )
  $exeTargets = @(
    (Join-Path $packageDir $exeName),
    (Join-Path $packageMirrorPackageDir $exeName)
  )

  foreach ($target in $apkTargets) {
    Copy-Item -LiteralPath $ApkPath -Destination (Assert-InWorkspace $target) -Force
  }
  foreach ($target in $exeTargets) {
    Copy-Item -LiteralPath $ExePath -Destination (Assert-InWorkspace $target) -Force
  }

  $apkHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $apkTargets[0]).Hash
  $exeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $exeTargets[0]).Hash
  $apkSize = Format-SizeMb (Get-Item -LiteralPath $apkTargets[0]).Length
  $exeSize = Format-SizeMb (Get-Item -LiteralPath $exeTargets[0]).Length
  $normalizedPackageRepository = ([string]$PackageRepository).Trim().Trim("/")
  if ($normalizedPackageRepository) {
    $apkLink = "https://github.com/$normalizedPackageRepository/blob/main/packages/$apkName`?raw=1"
    $exeLink = "https://github.com/$normalizedPackageRepository/blob/main/packages/$exeName`?raw=1"
  } else {
    $apkLink = "packages/$apkName"
    $exeLink = "packages/$exeName"
  }

  $packagesMd = @"
# Package List

## v$Version

| File | Platform | Notes |
| --- | --- | --- |
| [$apkName]($apkLink) | Android | Signed APK, package com.yehang.paotuan, versionCode $VersionCode, versionName $Version, size $apkSize MB. |
| [$exeName]($exeLink) | Windows | NSIS x64 installer built with Electron Builder, version $Version, size $exeSize MB. |

## SHA256

~~~text
$exeHash  $exeName
$apkHash  $apkName
~~~
"@
  [System.IO.File]::WriteAllText((Assert-InWorkspace (Join-Path $packageMirrorDir "PACKAGES.md")), $packagesMd)

  $mirrorApkHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $apkTargets[1]).Hash
  $mirrorExeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $exeTargets[1]).Hash
  if ($mirrorApkHash -ne $apkHash -or $mirrorExeHash -ne $exeHash) {
    throw "Published package hash mismatch between output/packages and github-release packages."
  }

  Write-Host "Published Android: $apkName $apkHash"
  Write-Host "Published Windows: $exeName $exeHash"
}

Use-PreferredJdk
Ensure-AndroidSigningEnv

Invoke-Step "Build web and server" {
  Invoke-NativeCommand -CommandPath "npm" -CommandArgs @("run", "build")
}

Invoke-Step "Sync native assets" {
  Invoke-NativeCommand -CommandPath "powershell" -CommandArgs @(
    "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $root "scripts/sync-native-assets.ps1"),
    "-Version", $Version,
    "-VersionCode", "$VersionCode",
    "-ApiBase", $ApiBase
  )
}

Invoke-Step "Verify native assets match web dist" {
  $previousExpectedApiBase = $env:NATIVE_EXPECTED_API_BASE
  try {
    $env:NATIVE_EXPECTED_API_BASE = $ApiBase
    Invoke-NativeCommand -CommandPath "npm" -CommandArgs @("run", "native:verify-assets")
  } finally {
    if ($null -eq $previousExpectedApiBase) {
      Remove-Item Env:NATIVE_EXPECTED_API_BASE -ErrorAction SilentlyContinue
    } else {
      $env:NATIVE_EXPECTED_API_BASE = $previousExpectedApiBase
    }
  }
}

Invoke-Step "Build signed Android release APK" {
  $env:GRADLE_USER_HOME = $gradleHome
  Invoke-NativeCommand -CommandPath (Resolve-GradleCommand) -CommandArgs @("-p", $androidDir, "clean", "assembleRelease")
}

$apkPath = Join-Path $androidDir "app/build/outputs/apk/release/app-release.apk"
if (-not (Test-Path -LiteralPath $apkPath -PathType Leaf)) {
  throw "Expected APK missing: $apkPath"
}

Invoke-Step "Verify Android APK" {
  Assert-Apk -ApkPath $apkPath
}

Invoke-Step "Build Windows installer" {
  Ensure-WindowsDependencies
  Invoke-NativeCommand -CommandPath "npm" -CommandArgs @("run", "dist") -WorkingDirectory $windowsDir
}

$exePath = Join-Path $windowsDir "dist/yehang-paotuan-windows-v$Version.exe"
if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) {
  throw "Expected Windows installer missing: $exePath"
}

Invoke-Step "Verify Windows package contents" {
  Assert-WindowsAsar
  Assert-WindowsAsarWebBundleMatchesDist
}

Invoke-Step "Publish packages and update hashes" {
  Publish-Packages -ApkPath $apkPath -ExePath $exePath
}
