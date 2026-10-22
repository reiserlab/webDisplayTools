# bias-ufmf.ps1 — put a running BIAS (external control on -Port) on ufmf logging into -VideoDir.
#
#   powershell -ExecutionPolicy Bypass -File tools\bias-ufmf.ps1 -VideoDir C:\rec\okey-cokey
#
# Run it after EVERY BIAS start: BIAS v0.73.1 (Spinnaker) comes up with its built-in defaults (jpg →
# %USERPROFILE%\Videos), and it rejects set-/load-configuration with "Unable to revert to previous
# configuration" until the camera has captured once (ww14 2026-10-22). So: connect, capture 2 s,
# stop, then load -Config with logging.format/directory overridden. The camera settings come from
# -Config, so pass one made for THIS camera (config/bias/), or omit it to keep BIAS's current camera
# settings and change only the logging block.
param(
    [string]$VideoDir = 'C:\rec\okey-cokey',
    [string]$Config = '',
    [int]$Port = 5010
)
$ErrorActionPreference = 'Stop'
$bias = "http://127.0.0.1:$Port/"
function Bias([string]$cmd) {
    $r = curl.exe -s -m 15 "$bias`?$cmd"
    if (-not $r) { throw "no reply from BIAS on port $Port (is it running with the external-control server on?)" }
    ($r | ConvertFrom-Json)[0]
}

New-Item -ItemType Directory -Force $VideoDir | Out-Null
[void](Bias 'connect')
[void](Bias 'start-capture')
Start-Sleep -Seconds 2
[void](Bias 'stop-capture')
Start-Sleep -Seconds 1

$cfg = if ($Config) { Get-Content $Config -Raw | ConvertFrom-Json } else { (Bias 'get-configuration').value }
$cfg.logging.format = 'ufmf'
$cfg.logging.directory = ($VideoDir -replace '\\', '/')
$tmp = Join-Path $env:TEMP 'bias-ufmf-config.json'
$cfg | ConvertTo-Json -Depth 10 | Out-File -Encoding ascii $tmp
$r = Bias "load-configuration=$([uri]::EscapeDataString($tmp))"
if (-not $r.success) { throw "load-configuration failed: $($r.message)" }

$log = (Bias 'get-configuration').value.logging
"BIAS logging: $($log.format) -> $($log.directory)"
if ($log.format -ne 'ufmf') { exit 1 }
