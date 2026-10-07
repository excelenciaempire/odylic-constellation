#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallDirectory = $(if ($env:ODYLIC_CONSTELLATION_DIR) { $env:ODYLIC_CONSTELLATION_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\Odylic Constellation' }),
    [string]$Repository = $(if ($env:ODYLIC_CONSTELLATION_REPO) { $env:ODYLIC_CONSTELLATION_REPO } else { 'excelenciaempire/odylic-constellation' }),
    [switch]$SkipGit,
    [switch]$DesktopShortcut,
    [switch]$NoShortcut
)
. (Join-Path $PSScriptRoot 'scripts\windows-common.ps1')
Write-Host 'Installing Odylic Constellation for Windows'
$appDirectory = [System.IO.Path]::GetFullPath($InstallDirectory)
if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { throw 'Git is required: https://git-scm.com/download/win' }
$python = Get-OdylicPython
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Node.js 20.19+, 22.12+, or newer is required: https://nodejs.org/' }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm is required (included with Node.js).' }
Invoke-OdylicNative 'node.exe' @('-e', 'const [a,b]=process.versions.node.split(String.fromCharCode(46)).map(Number);process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>22?0:1)')
$endpoint = Get-OdylicEndpoint
$wasRunning = $false
$venvPython = Join-Path $appDirectory '.venv\Scripts\python.exe'
if ((Test-Path -LiteralPath $venvPython) -and (Test-Path -LiteralPath (Join-Path $appDirectory 'api\healthcheck.py'))) {
    Push-Location -LiteralPath $appDirectory
    try {
        $state = Get-OdylicServerState $venvPython $endpoint.Url '--stop-ours'
        if ($state -in @('ours', 'stale')) { throw 'The running app could not be stopped. Refusing to update files used by a live server.' }
        $wasRunning = $state -eq 'stopped'
    } finally { Pop-Location }
}
if ($SkipGit -or $env:ODYLIC_CONSTELLATION_SKIP_GIT -eq '1') {
    if (-not (Test-Path -LiteralPath (Join-Path $appDirectory 'requirements.txt'))) { throw 'SkipGit requires an existing source checkout.' }
} elseif (Test-Path -LiteralPath (Join-Path $appDirectory '.git')) {
    Invoke-OdylicNative 'git.exe' @('-C', $appDirectory, 'pull', '--ff-only')
} elseif (Test-Path -LiteralPath $appDirectory) {
    throw "$appDirectory exists but is not a Git checkout. Choose another InstallDirectory."
} else {
    $repositoryUrl = if ($Repository -match '^https://') { $Repository } else { "https://github.com/$Repository.git" }
    Invoke-OdylicNative 'git.exe' @('clone', '--depth', '1', '--', $repositoryUrl, $appDirectory)
}
Push-Location -LiteralPath $appDirectory
try {
    Write-Host '1/3 Setting up the private Python environment'
    if (-not (Test-Path -LiteralPath $venvPython)) { Invoke-OdylicNative $python @('-m', 'venv', '.venv') }
    Invoke-OdylicNative $venvPython @('-m', 'ensurepip', '--upgrade')
    Invoke-OdylicNative $venvPython @('-m', 'pip', 'install', '--disable-pip-version-check', 'pip==26.2.1')
    Invoke-OdylicNative $venvPython @('-m', 'pip', 'install', '--disable-pip-version-check', '-r', 'requirements.txt', '-c', 'constraints.txt')
    Write-Host '2/3 Building the 3D app (about 60 seconds on the first installation)'
    Push-Location -LiteralPath (Join-Path $appDirectory 'web')
    try {
        Invoke-OdylicNative 'npm.cmd' @('ci', '--no-fund', '--no-audit')
        Invoke-OdylicNative 'npm.cmd' @('run', 'build')
    } finally { Pop-Location }
    if (-not (Test-Path -LiteralPath (Join-Path $appDirectory 'web\dist\index.html'))) { throw 'The web build did not produce index.html.' }
    Write-Host '3/3 Creating the Windows launcher'
    if (-not $NoShortcut) {
        & (Join-Path $appDirectory 'scripts\make-app.ps1') -InstallDirectory $appDirectory -Desktop:$DesktopShortcut
    }
    if ($wasRunning) { & (Join-Path $appDirectory 'start.ps1') -Background }
} finally { Pop-Location }
Write-Host "Installation complete. Open Odylic Constellation from the Start menu, or run $appDirectory\start.cmd"
