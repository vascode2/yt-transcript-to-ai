# Manual smoke: Brave with unpacked extension + target watch URL.
# Usage (from repo root):
#   .\scripts\launch-brave-with-extension.ps1
# Optional: $env:BRAVE_PATH = "D:\Apps\Brave\Application\brave.exe"

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$ext = (Resolve-Path (Join-Path $repoRoot "extension")).Path
$brave = $env:BRAVE_PATH
if (-not $brave) {
  $brave = "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
}
if (-not (Test-Path $brave)) {
  Write-Error "Brave not found at: $brave`nSet BRAVE_PATH to brave.exe"
}
$url = "https://www.youtube.com/watch?v=YOhZd1-AkNk"
Start-Process -FilePath $brave -ArgumentList @(
  "--load-extension=$ext",
  $url
)
