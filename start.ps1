#Requires -Version 5.1
<##
.SYNOPSIS
Start the local Windows app. No browser opens unless -OpenBrowser is given.
.EXAMPLE
.\start.ps1 -Background
##>
[CmdletBinding()]
param([switch]$Background, [switch]$OpenBrowser)

. (Join-Path $PSScriptRoot 'scripts\windows-common.ps1')
$appDirectory = $PSScriptRoot
$python = Join-Path $appDirectory '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw 'The Python environment is missing. Run install.cmd first.'
}
if (-not (Test-Path -LiteralPath (Join-Path $appDirectory 'web\dist\index.html') -PathType Leaf)) {
    throw 'The web app is not built. Run install.cmd first.'
}
$endpoint = Get-OdylicEndpoint
Push-Location -LiteralPath $appDirectory
try {
    $state = Get-OdylicServerState $python $endpoint.Url '--stop-stale'
    if ($state -eq 'foreign') { throw "Port $($endpoint.Port) is in use by another program. Set ODYLIC_PORT to an available port." }
    if ($state -eq 'stale') { throw 'The older Odylic server could not be stopped safely. Run stop.cmd from its installation folder.' }
    if ($state -eq 'ours') {
        Write-Host "Odylic Constellation is already running at $($endpoint.Url)"
        if ($OpenBrowser) { Start-Process -FilePath $endpoint.Url }
        return
    }
    $arguments = @('-m', 'uvicorn', 'api.main:app', '--host', $endpoint.HostName, '--port', "$($endpoint.Port)", '--log-level', 'warning')
    if (-not $Background -and -not $OpenBrowser) {
        Write-Host "Odylic Constellation: $($endpoint.Url) (Ctrl+C to stop)"
        Invoke-OdylicNative $python $arguments
        return
    }
    $logDirectory = Get-OdylicLogDirectory
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $stdout = Join-Path $logDirectory 'server.log'
    $stderr = Join-Path $logDirectory 'server-error.log'
    foreach ($log in @($stdout, $stderr)) {
        if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 1048576) {
            Move-Item -LiteralPath $log -Destination "$log.previous" -Force
        }
    }
    $server = Start-Process -FilePath $python -ArgumentList $arguments -WorkingDirectory $appDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Milliseconds 250
        $server.Refresh()
        if ($server.HasExited) { break }
        if ((Get-OdylicServerState $python $endpoint.Url) -eq 'ours') { $ready = $true; break }
    }
    if (-not $ready) {
        # This handle belongs to the process we just created, never another app.
        $server.Refresh()
        if (-not $server.HasExited) { $server.Kill() }
        throw "The local server did not become ready. See $stderr"
    }
    Write-Host "Odylic Constellation: $($endpoint.Url)"
    if ($OpenBrowser) { Start-Process -FilePath $endpoint.Url }
    if (-not $Background) {
        Write-Host 'Press Ctrl+C to stop.'
        try { $server.WaitForExit() }
        finally {
            $server.Refresh()
            if (-not $server.HasExited) { $server.Kill() }
        }
    }
} finally { Pop-Location }
