# okey-cokey-start.ps1 — start the okey-cokey rig stack so nothing that launched it can stop it.
#
#   powershell -ExecutionPolicy Bypass -File tools\okey-cokey-start.ps1
#   powershell -ExecutionPolicy Bypass -File tools\okey-cokey-start.ps1 -Protocol g6_color_optomotor_smoke
#
# Starts BIAS (unless it already answers on 5010), puts it on ufmf (tools\bias-ufmf.ps1), then opens
# two PowerShell consoles, the rig ("okey-cokey RIG") and the Studio page server ("okey-cokey STUDIO
# SERVER :8092"), and the Studio in Chrome. On ww14 (Windows 11, Windows Terminal as the default
# terminal) the two consoles open as TABS of one Windows Terminal window, not as separate windows.
# Stop the rig with Ctrl-C in ITS tab (the bag closes cleanly); close the server tab when done.
#
# Why WMI (Win32_Process.Create) and not Start-Process: on ww14 (2026-10-22) the Claude desktop app
# restarted itself 9 min into a full run, and BIAS, the rig and the server, all started from a Claude
# session, died with it. Processes created through WMI are children of WmiPrvSE, not of the caller, so
# closing the launching terminal or app leaves them running.
param(
    [string]$Bias = 'C:\Users\labadmin\Documents\FlyBowl1Rig\BIAS_exe_spinnaker_win64_v0_73_1\v0.73.1\test_gui.exe',
    [string]$VideoDir = 'C:\rec\okey-cokey',
    [string]$BiasConfig = 'config\bias\okey-cokey-bfs-u3-51s5m.json',
    [string]$Protocol = 'g6_color_optomotor_test',
    [string]$Rig = 'cshl_g6_2x10',
    [int]$StudioPort = 8092
)
$ErrorActionPreference = 'Stop'
$poc = Split-Path $PSScriptRoot -Parent          # rig
$repo = Split-Path $poc -Parent                  # webDisplayTools

function Detached([string]$cmdLine, [string]$dir) {
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
        -Arguments @{ CommandLine = $cmdLine; CurrentDirectory = $dir }
    if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed ($($r.ReturnValue)): $cmdLine" }
    $r.ProcessId
}
function Listening([int]$port) {
    [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}
function WaitFor([int[]]$ports, [int]$seconds, [string]$what) {
    for ($i = 0; $i -lt $seconds; $i++) {
        if (-not ($ports | Where-Object { -not (Listening $_) })) { return }
        Start-Sleep -Seconds 1
    }
    throw "$what not listening on $($ports -join ', ') after $seconds s"
}
function Encoded([string]$s) { [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($s)) }

# 1. BIAS
if (Listening 5010) {
    Write-Host 'BIAS: already answering on 5010'
} else {
    if (-not (Test-Path $Bias)) { throw "BIAS not found: $Bias" }
    $id = Detached "`"$Bias`"" (Split-Path $Bias)
    WaitFor @(5010) 30 'BIAS'
    Write-Host "BIAS: started (pid $id)"
}
& powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'bias-ufmf.ps1') `
    -VideoDir $VideoDir -Config (Join-Path $poc $BiasConfig)
if ($LASTEXITCODE) { throw 'bias-ufmf.ps1 failed' }

# 2. Rig and Studio server, each in its own window (-EncodedCommand avoids nested quoting).
$rigCmd = @"
`$Host.UI.RawUI.WindowTitle = 'okey-cokey RIG (Ctrl-C to stop)'
Set-Location '$poc'
pixi run rig -- --no-fictrac --bias --bias-args "--video-dir $VideoDir" --foxglove --viz-args "--sources bias" --stimulus-args "--panel-layout four-color"
"@
$srvCmd = @"
`$Host.UI.RawUI.WindowTitle = 'okey-cokey STUDIO SERVER :$StudioPort'
Set-Location '$repo'
pixi run python .claude\nocache-server.py $StudioPort
"@
if (Listening 8765) { Write-Host 'rig: 8765 already in use, not starting a second rig' }
else { [void](Detached "powershell.exe -NoExit -ExecutionPolicy Bypass -EncodedCommand $(Encoded $rigCmd)" $poc) }
if (Listening $StudioPort) { Write-Host "server: $StudioPort already in use, not starting another" }
else { [void](Detached "powershell.exe -NoExit -ExecutionPolicy Bypass -EncodedCommand $(Encoded $srvCmd)" $repo) }
WaitFor @(7447, 8765, 8766, $StudioPort) 90 'rig / Studio server'
Write-Host "up: BIAS 5010, zenoh 7447, Studio bridge 8765, Foxglove 8766, Studio page $StudioPort"
Write-Host 'The rig and the server run in two tabs of a Windows Terminal window (or two console windows).'
Write-Host 'To stop: Ctrl-C in the "okey-cokey RIG" tab, then close the "okey-cokey STUDIO SERVER" tab.'

# 3. Studio
$url = "http://localhost:$StudioPort/arena_studio.html?p=$Protocol&rig=$Rig&mode=run"
Start-Process chrome $url
Write-Host "Studio: $url"
Write-Host 'Pick the controller by the name G6_Arena in the port picker (its COM number has changed).'
