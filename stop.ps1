#Requires -Version 5.1
[CmdletBinding()]
param()
. (Join-Path $PSScriptRoot 'scripts\windows-common.ps1')
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'The Python environment is missing.' }
$endpoint = Get-OdylicEndpoint
Push-Location -LiteralPath $PSScriptRoot
try {
    $state = Get-OdylicServerState $python $endpoint.Url '--stop-ours'
    switch ($state) {
        'stopped' { Write-Host 'Odylic Constellation stopped.' }
        'down' { Write-Host 'Odylic Constellation is not running.' }
        'foreign' { throw "Port $($endpoint.Port) belongs to another program. It has not been stopped." }
        default { throw 'The server could not be stopped safely. No unrelated process was terminated.' }
    }
} finally { Pop-Location }
