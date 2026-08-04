# runx installer for Windows.
#
#   irm runx.ai/install.ps1 | iex
#
# Downloads the prebuilt binary from the GitHub Release, verifies its sha256, and
# installs it. Honors $env:RUNX_VERSION (default: latest cli-v* release) and
# $env:RUNX_INSTALL_DIR (default: %LOCALAPPDATA%\runx\bin).
$ErrorActionPreference = "Stop"
$repo = "runxhq/runx"

$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -ne "AMD64") { throw "unsupported architecture: $arch (only x64 is published)" }
$target = "x86_64-pc-windows-msvc"

$version = $env:RUNX_VERSION
if (-not $version) {
  Write-Host "runx: resolving latest release..."
  $releases = Invoke-RestMethod "https://api.github.com/repos/$repo/releases"
  $tag = ($releases | Where-Object { $_.tag_name -like "cli-v*" } | Select-Object -First 1).tag_name
  if (-not $tag) { throw "could not resolve latest cli-v* release; set `$env:RUNX_VERSION" }
  $version = $tag
}
$version = $version -replace '^cli-v','' -replace '^v',''

$archive = "runx-$version-$target.zip"
$base = if ($env:RUNX_BASE_URL) { $env:RUNX_BASE_URL } else { "https://github.com/$repo/releases/download/cli-v$version" }
$tmp = Join-Path $env:TEMP ("runx-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "runx: downloading $version ($target)"
  Invoke-WebRequest "$base/$archive" -OutFile "$tmp\$archive"

  try {
    Invoke-WebRequest "$base/$archive.sha256" -OutFile "$tmp\$archive.sha256"
    $expected = (Get-Content "$tmp\$archive.sha256").Split(" ")[0]
    $actual = (Get-FileHash "$tmp\$archive" -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) { throw "checksum mismatch (expected $expected, got $actual)" }
    Write-Host "runx: checksum verified"
  } catch { Write-Warning "runx: skipping checksum verification ($_)" }

  Expand-Archive "$tmp\$archive" -DestinationPath $tmp -Force
  $dir = $env:RUNX_INSTALL_DIR
  if (-not $dir) { $dir = Join-Path $env:LOCALAPPDATA "runx\bin" }
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  Copy-Item "$tmp\runx-$version-$target\runx.exe" "$dir\runx.exe" -Force
  Copy-Item "$tmp\runx-$version-$target\runx-js-worker.exe" "$dir\runx-js-worker.exe" -Force
  Write-Host "runx: installed to $dir\runx.exe"

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($userPath -notlike "*$dir*") {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$dir", "User")
    Write-Host "runx: added $dir to your user PATH (restart your shell)"
  }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
