<#
  Copy-transcript flake harness.

  Each iteration spawns one Playwright run of the "copy-flake" test, parses the
  COPY_FLAKE_RESULT|... line + the per-run diag folder, and aggregates results.

  Stop conditions:
    * -RequireConsecutivePasses N (default 5): stop early on a streak of N OKs.
    * -Runs M (default 10): hard cap on total iterations.
    * -StopOnFirstFailure: bail at the first non-OK iteration (debugging mode).

  Usage:
    .\scripts\copy-flake-loop.ps1                    # 10 runs, primary URL
    .\scripts\copy-flake-loop.ps1 -Runs 20
    .\scripts\copy-flake-loop.ps1 -Url 'https://www.youtube.com/watch?v=YOhZd1-AkNk'
    .\scripts\copy-flake-loop.ps1 -RequireConsecutivePasses 5
#>

[CmdletBinding()]
param(
  [int]$Runs = 10,
  [int]$RequireConsecutivePasses = 5,
  [switch]$StopOnFirstFailure,
  [string]$Url = 'https://www.youtube.com/watch?v=blxtjqlMiXM',
  [string]$BravePath
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if ($BravePath) { $env:BRAVE_PATH = $BravePath }
$env:COPY_FLAKE_URL = $Url

$batchTag  = "batch-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$batchRoot = Join-Path $repoRoot "test-results\diag\$batchTag"
New-Item -ItemType Directory -Force -Path $batchRoot | Out-Null

$rows = New-Object System.Collections.Generic.List[object]
$streak = 0
$bestStreak = 0

for ($i = 1; $i -le $Runs; $i++) {
  $runTag = "$batchTag\iter-$('{0:D2}' -f $i)"
  $env:COPY_FLAKE_RUN_TAG = $runTag
  $iterRoot = Join-Path $repoRoot "test-results\diag\$runTag"

  Write-Host ""
  Write-Host "================ iteration $i / $Runs ================" -ForegroundColor Cyan
  Write-Host "URL : $Url"
  Write-Host "Tag : $runTag"

  # Google Drive's virtual FS occasionally NAKs writes to a freshly-created
  # subfolder. Use a local temp file for the live log, then copy into the
  # batch folder once the iteration finishes.
  $tmpLog  = Join-Path $env:TEMP ("yts-flake-iter-{0:D2}-{1}.log" -f $i, [guid]::NewGuid().ToString('N').Substring(0,8))
  $logPath = Join-Path $batchRoot ("iter-{0:D2}.log" -f $i)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()

  # Run a single test invocation. We deliberately match by file so beforeAll
  # spins a fresh persistent context per iteration (clean SPA / extension state).
  & npx playwright test e2e/copy-flake.spec.ts --reporter=list 2>&1 |
    Tee-Object -FilePath $tmpLog | Out-Host

  $sw.Stop()
  try { Copy-Item -LiteralPath $tmpLog -Destination $logPath -Force } catch { $logPath = $tmpLog }
  $iterMs = [int]$sw.Elapsed.TotalMilliseconds

  $line = Select-String -Path $logPath -Pattern '^COPY_FLAKE_RESULT\|' -SimpleMatch:$false |
          Select-Object -Last 1
  $code = 'NO_RESULT_LINE'
  $statusText = ''
  $elapsedMs = 0
  if ($line) {
    $parts = $line.Line -split '\|', 4
    if ($parts.Length -ge 4) {
      $code       = $parts[1]
      $elapsedMs  = [int]$parts[2]
      $statusText = $parts[3]
    }
  }

  $summaryPath = Join-Path $iterRoot 'summary.json'
  $tracks = $null; $clip = $null; $itKey = $null
  if (Test-Path $summaryPath) {
    try {
      $j = Get-Content $summaryPath -Raw | ConvertFrom-Json
      $tracks = $j.probeBefore.captionTracks
      $clip   = $j.probeBefore.clipboardWrite
      $itKey  = $j.probeBefore.innertubeKeyExposed
    } catch { }
  }

  $rows.Add([pscustomobject]@{
    Iter        = $i
    Code        = $code
    ElapsedMs   = $elapsedMs
    IterMs      = $iterMs
    Tracks      = $tracks
    Clipboard   = $clip
    InnertubeKey= $itKey
    Status      = ($statusText -replace '\s+', ' ').Trim()
  }) | Out-Null

  if ($code -eq 'OK') {
    $streak++
    if ($streak -gt $bestStreak) { $bestStreak = $streak }
    Write-Host ("  -> OK   streak={0}/{1}" -f $streak, $RequireConsecutivePasses) -ForegroundColor Green
    if ($streak -ge $RequireConsecutivePasses) {
      Write-Host ""
      Write-Host "STOP: hit $RequireConsecutivePasses consecutive passes." -ForegroundColor Green
      break
    }
  } else {
    $streak = 0
    Write-Host ("  -> FAIL ({0})  status: {1}" -f $code, $statusText) -ForegroundColor Yellow
    if ($StopOnFirstFailure) {
      Write-Host "STOP: -StopOnFirstFailure was set." -ForegroundColor Yellow
      break
    }
  }
}

Write-Host ""
Write-Host "================ batch summary ================" -ForegroundColor Cyan
$rows | Format-Table -AutoSize | Out-Host

$counts = $rows | Group-Object Code | Sort-Object Count -Descending |
          Select-Object Count, Name
Write-Host "Code distribution:" -ForegroundColor Cyan
$counts | Format-Table -AutoSize | Out-Host

$total = $rows.Count
$ok    = ($rows | Where-Object Code -eq 'OK').Count
Write-Host ("Pass rate: {0}/{1}  best streak: {2}" -f $ok, $total, $bestStreak) -ForegroundColor Cyan

# Save aggregate JSON.
$aggPath = Join-Path $batchRoot 'aggregate.json'
$rows | ConvertTo-Json -Depth 5 | Out-File -FilePath $aggPath -Encoding utf8
Write-Host "Aggregate written to: $aggPath"

# Exit code: 0 if streak target met, otherwise 1.
if ($streak -ge $RequireConsecutivePasses) { exit 0 } else { exit 1 }
