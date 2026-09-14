Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$manifestPath = Join-Path $projectRoot "manifest.json"
$targetPath = Join-Path $projectRoot "target"
$stagingPath = Join-Path $targetPath ".staging"

if (-not (Test-Path $manifestPath -PathType Leaf)) {
  throw "manifest.json was not found."
}

$manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json
if ($manifest.manifest_version -ne 3) {
  throw "The extension must use Manifest V3."
}

$requiredFiles = @(
  "manifest.json",
  "icons/icon128.png",
  "src/background.js",
  "src/options.css",
  "src/options.html",
  "src/options.js",
  "src/popup.css",
  "src/popup.html",
  "src/popup.js",
  "src/sync-service.js"
)

foreach ($relativePath in $requiredFiles) {
  $filePath = Join-Path $projectRoot $relativePath
  if (-not (Test-Path $filePath -PathType Leaf)) {
    throw "Required release file is missing: $relativePath"
  }
}

New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
if (Test-Path $stagingPath) {
  Remove-Item $stagingPath -Recurse -Force
}
New-Item -ItemType Directory -Path $stagingPath -Force | Out-Null

$releaseName = "KeeprSync-v$($manifest.version).zip"
$releasePath = Join-Path $targetPath $releaseName

try {
  Copy-Item (Join-Path $projectRoot "manifest.json") $stagingPath
  Copy-Item (Join-Path $projectRoot "icons") (Join-Path $stagingPath "icons") -Recurse
  Copy-Item (Join-Path $projectRoot "src") (Join-Path $stagingPath "src") -Recurse

  if (Test-Path $releasePath) {
    Remove-Item $releasePath -Force
  }

  Compress-Archive -Path (Join-Path $stagingPath "*") -DestinationPath $releasePath -CompressionLevel Optimal
  Write-Output "Release created: $releasePath"
}
finally {
  if (Test-Path $stagingPath) {
    Remove-Item $stagingPath -Recurse -Force
  }
}