# Shared by the Windows installer and launchers. Windows PowerShell 5.1+.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-OdylicNative {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Executable exited with code $LASTEXITCODE." }
}

function Get-OdylicPython {
    if ($env:ODYLIC_CONSTELLATION_PYTHON) {
        $candidate = $env:ODYLIC_CONSTELLATION_PYTHON
        & $candidate -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'
        if ($LASTEXITCODE -ne 0) { throw 'ODYLIC_CONSTELLATION_PYTHON must point to Python 3.10 or newer.' }
        return $candidate
    }
    if (Get-Command py.exe -ErrorAction SilentlyContinue) {
        $candidate = & py.exe -3 -c 'import sys; print(sys.executable) if sys.version_info >= (3, 10) else sys.exit(1)' 2>$null
        if ($LASTEXITCODE -eq 0 -and $candidate) { return $candidate.Trim() }
    }
    foreach ($name in @('python.exe', 'python3.exe')) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command -and $command.Source -notlike '*\WindowsApps\*') {
            & $command.Source -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>$null
            if ($LASTEXITCODE -eq 0) { return $command.Source }
        }
    }
    throw 'Python 3.10 or newer is required. Install it from https://www.python.org/downloads/windows/ (enable the Python launcher).'
}

function Get-OdylicEndpoint {
    $bindAddress = if ($env:ODYLIC_HOST) { $env:ODYLIC_HOST } else { '127.0.0.1' }
    $bindAddress = $bindAddress.Trim('[', ']')
    $port = 8777
    if ($env:ODYLIC_PORT -and (-not [int]::TryParse($env:ODYLIC_PORT, [ref]$port))) {
        throw 'ODYLIC_PORT must be a number from 1 to 65535.'
    }
    if ($port -lt 1 -or $port -gt 65535) { throw 'ODYLIC_PORT must be a number from 1 to 65535.' }
    $address = $null
    $loopback = $bindAddress -eq 'localhost' -or (
        [System.Net.IPAddress]::TryParse($bindAddress, [ref]$address) -and [System.Net.IPAddress]::IsLoopback($address))
    if (-not $loopback -and $env:ODYLIC_ALLOW_LAN -ne '1') {
        throw "Refusing to listen on $bindAddress. The app has no login. Set ODYLIC_ALLOW_LAN=1 only if you intend to expose your ad data and Meta token to that network."
    }
    $checkAddress = if ($loopback) { $bindAddress } else { '127.0.0.1' }
    if ($checkAddress.Contains(':')) { $checkAddress = "[$checkAddress]" }
    return @{ HostName = $bindAddress; Port = $port; Url = "http://${checkAddress}:$port" }
}

function Get-OdylicServerState {
    param([string]$Python, [string]$Url, [string]$Action = '')
    $arguments = @('-m', 'api.healthcheck', $Url)
    if ($Action) { $arguments += $Action }
    $state = & $Python @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Could not verify the local server identity. Refusing to continue.' }
    $state = ($state | Select-Object -Last 1).Trim()
    if ($state -notin @('ours', 'stale', 'foreign', 'down', 'stopped')) {
        throw "Unexpected local server status: $state"
    }
    return $state
}

function Get-OdylicLogDirectory {
    if ($env:ODYLIC_FUNNEL_DATA_DIR) { return Join-Path $env:ODYLIC_FUNNEL_DATA_DIR 'logs' }
    $localDirectory = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\Local' }
    return Join-Path $localDirectory 'Odylic Constellation\logs'
}
