# Replay bags through PR #252's viz_node at 1x and capture /viz/* + /diagnostics + /viz/markers.
#   replay.ps1 <bagdir> [<bagdir> ...]      (writes <scratch>\vizraw\<run>\ and <scratch>\vizraw\<run>.log)
param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Bags)
$ErrorActionPreference = 'Stop'
$poc = 'C:\Users\reiserm\Documents\GitHub\webDisplayTools\ros2-poc'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$raw = Join-Path (Split-Path -Parent $here) 'vizraw'
New-Item -ItemType Directory -Force $raw | Out-Null

function Start-Bg($name, [string[]] $argv) {
    $log = Join-Path $raw "$name.log"
    Start-Process -FilePath pixi -ArgumentList $argv -WorkingDirectory $poc -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $log -RedirectStandardError "$log.err"
}
function Stop-Tree($p) { if ($p -and -not $p.HasExited) { & taskkill /T /F /PID $p.Id | Out-Null } }
function Wait-For($file, $pattern, $sec) {
    $t = [Diagnostics.Stopwatch]::StartNew()
    while ($t.Elapsed.TotalSeconds -lt $sec) {
        if ((Test-Path $file) -and (Select-String -Path $file -Pattern $pattern -Quiet)) { return $true }
        Start-Sleep -Milliseconds 200
    }
    return $false
}

$router = Start-Bg 'router' @('run', 'router')
Start-Sleep -Seconds 4
try {
    foreach ($bag in $Bags) {
        $run = (Split-Path -Leaf $bag) -replace '\.bag$', ''
        $out = Join-Path $raw $run
        $stop = Join-Path $raw "$run.stop"
        Remove-Item -Recurse -Force $out, $stop -ErrorAction SilentlyContinue
        $t0 = Get-Date
        $cap = $null; $viz = $null
        try {
            $cap = Start-Bg "$run.capture" @('run', 'python', (Join-Path $here 'viz_capture.py'), $out, $stop)
            if (-not (Wait-For (Join-Path $raw "$run.capture.log") 'capture\] up' 60)) { throw "capture did not start for $run" }
            $viz = Start-Bg "$run.viz" @('run', 'python', (Join-Path $here 'viz_node.py'))
            Start-Sleep -Seconds 4
            $playLog = Join-Path $raw "$run.play.log"
            & cmd /c "pixi run --manifest-path `"$poc\pixi.toml`" ros2 bag play `"$bag`" --delay 3 --topics /fictrac/raw /arena/frame /bias/status /bias/reply /kinefly/raw > `"$playLog`" 2>&1"
            Start-Sleep -Seconds 3
            New-Item -ItemType File $stop | Out-Null
            $null = $cap.WaitForExit(30000)
        }
        finally { Stop-Tree $cap; Stop-Tree $viz }
        "{0}: {1:N0} s; {2}" -f $run, ((Get-Date) - $t0).TotalSeconds, ((Get-Content (Join-Path $raw "$run.capture.log") -Tail 1))
    }
}
finally { Stop-Tree $router }
