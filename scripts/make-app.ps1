#Requires -Version 5.1
[CmdletBinding()]
param([string]$InstallDirectory = (Split-Path -Parent $PSScriptRoot), [switch]$Desktop)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$appDirectory = [System.IO.Path]::GetFullPath($InstallDirectory)
if (-not (Test-Path -LiteralPath (Join-Path $appDirectory 'start.ps1'))) { throw 'Not an Odylic Constellation installation.' }
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Odylic Constellation'
New-Item -ItemType Directory -Path $startMenu -Force | Out-Null
$shell = New-Object -ComObject WScript.Shell
$locations = @($startMenu)
if ($Desktop) { $locations += [Environment]::GetFolderPath('Desktop') }
foreach ($directory in $locations) {
    $shortcut = $shell.CreateShortcut((Join-Path $directory 'Odylic Constellation.lnk'))
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $appDirectory 'start.ps1')`" -Background -OpenBrowser"
    $shortcut.WorkingDirectory = $appDirectory
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'Explore your Meta ads in 3D. Local, read-only, and private.'
    $shortcut.Save()
}
$stopShortcut = $shell.CreateShortcut((Join-Path $startMenu 'Stop Odylic Constellation.lnk'))
$stopShortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$stopShortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $appDirectory 'stop.ps1')`""
$stopShortcut.WorkingDirectory = $appDirectory
$stopShortcut.WindowStyle = 7
$stopShortcut.Save()
Write-Host "Windows shortcuts ready: $startMenu"
