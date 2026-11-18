# fisheye benchmark: per-stage time + peak memory
# usage: pwsh -File tools/bench.ps1
# requires: cache/<id>.mp4 present (run auto once), ffmpeg available
param(
  [string]$Id = 'BV1WhaA6hE7s',
  [string]$Repo = 'C:\Users\Marsw\Documents\deepseek-harness\fisheye-publish\fisheye'
)
$ErrorActionPreference = 'Stop'
$env:FFMPEG = 'C:\Users\Marsw\.dsh\surfcore\bili\bin\ffmpeg.exe'
$env:BILI_CRED = 'C:\Users\Marsw\.dsh\surfcore\bili\credentials.json'
$node = 'C:\Program Files\nodejs\node.exe'

function Sample-TreePeak($rootPid) {
  # sample peak WorkingSet of the process tree
  $peak = 0L
  while ($true) {
    $proc = Get-Process -Id $rootPid -ErrorAction SilentlyContinue
    if (-not $proc) { break }
    $tree = @($proc)
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$rootPid" -ErrorAction SilentlyContinue
    foreach ($c in $children) { $cp = Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue; if ($cp) { $tree += $cp } }
    $sum = ($tree | Measure-Object -Property WorkingSet64 -Sum).Sum
    if ($sum -gt $peak) { $peak = [long]$sum }
    Start-Sleep -Milliseconds 150
  }
  return $peak
}

function Bench($label, $cmdArgs) {
  $out = "$env:TEMP\bench-$([guid]::NewGuid().ToString('N')).out"
  $err = "$env:TEMP\bench-$([guid]::NewGuid().ToString('N')).err"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $proc = Start-Process -FilePath $node -ArgumentList $cmdArgs -WorkingDirectory $Repo -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
  $peak = Sample-TreePeak $proc.Id
  $proc.WaitForExit()
  $sw.Stop()
  $ok = ($proc.ExitCode -eq 0)
  $mb = [math]::Round($peak / 1MB, 0)
  $sec = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  [pscustomobject]@{ Label = $label; Seconds = $sec; PeakMB = $mb; Exit = $proc.ExitCode; Ok = $ok }
  Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
}

$results = @()
$fisheye = Join-Path $Repo 'fisheye.mjs'
$results += Bench 'auto full pipeline (40min, cached)' @($fisheye, 'auto', $Id, '--budget', '20000')
$results += Bench 'grid (frame extraction + compose)' @($fisheye, 'grid', $Id)
$results += Bench 'subs (subtitle band)' @($fisheye, 'subs', $Id)
$results += Bench 'ocr (one sample image)' @($fisheye, 'ocr', (Join-Path $Repo 'test\ocr-sample.png'))
$results += Bench 'selftest (probes)' @($fisheye, 'selftest')

$results | Format-Table -AutoSize
$json = $results | ConvertTo-Json -Depth 3
$json | Set-Content "$env:TEMP\fisheye-bench.json" -Encoding UTF8
Write-Host "`nJSON: $env:TEMP\fisheye-bench.json"
