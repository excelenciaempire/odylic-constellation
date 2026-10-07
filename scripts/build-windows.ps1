[CmdletBinding()]
param([switch]$SkipWebBuild, [switch]$SkipInstaller, [switch]$SkipDependencies)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $projectRoot '.venv/Scripts/python.exe'
if (!(Test-Path -LiteralPath $python)) { throw 'Install the development dependencies with install.ps1 first.' }
Push-Location -LiteralPath $projectRoot
$previousCacheDirectory = $env:PYINSTALLER_CONFIG_DIR
$env:PYINSTALLER_CONFIG_DIR = Join-Path $projectRoot '.run/pyinstaller-cache'
try {
  if (!$SkipWebBuild) {
    Push-Location -LiteralPath (Join-Path $projectRoot 'web')
    try {
      & npm.cmd ci
      if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
      & npm.cmd run build
      if ($LASTEXITCODE -ne 0) { throw 'Web build failed.' }
    } finally { Pop-Location }
  }
  if (!(Test-Path -LiteralPath 'web/dist/index.html')) { throw 'The web app has not been built.' }
  if (!$SkipDependencies) {
    & $python -m ensurepip --upgrade
    if ($LASTEXITCODE -ne 0) { throw 'pip setup failed.' }
    & $python -m pip install -r requirements-windows.txt
    if ($LASTEXITCODE -ne 0) { throw 'Packaging dependencies could not be installed.' }
  }
  & $python scripts/windows/make-icon.py
  if ($LASTEXITCODE -ne 0) { throw 'Icon generation failed.' }
  & $python -m PyInstaller --noconfirm --clean scripts/windows/constellation.spec
  if ($LASTEXITCODE -ne 0) { throw 'PyInstaller failed.' }
  New-Item -ItemType Directory -Path 'release' -Force | Out-Null
  Compress-Archive -LiteralPath 'dist/Odylic Constellation' -DestinationPath 'release/Odylic-Constellation-Windows-Portable.zip' -Force
  if (!$SkipInstaller) {
    $compiler = Join-Path $env:LOCALAPPDATA 'Programs/Inno Setup 6/ISCC.exe'
    if (!(Test-Path -LiteralPath $compiler)) { $compiler = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6/ISCC.exe' }
    if (!(Test-Path -LiteralPath $compiler)) { throw 'Install Inno Setup 6 to compile the Windows installer.' }
    & $compiler /Qp scripts/windows/installer.iss
    if ($LASTEXITCODE -ne 0) { throw 'Windows installer compilation failed.' }
  }
  $artifactPaths = @('release/Odylic-Constellation-Windows-Portable.zip')
  if (!$SkipInstaller) { $artifactPaths += 'release/Odylic-Constellation-Windows-Setup.exe' }
  $checksums = $artifactPaths | ForEach-Object { Get-FileHash -LiteralPath $_ -Algorithm SHA256 } |
    ForEach-Object { '{0}  {1}' -f $_.Hash.ToLowerInvariant(), (Split-Path -Leaf $_.Path) } |
    Out-String
  $checksums.TrimEnd() | Set-Content -LiteralPath 'release/SHA256SUMS.txt' -Encoding ascii
  Write-Output 'Windows artifacts built in release/.'
} finally { $env:PYINSTALLER_CONFIG_DIR = $previousCacheDirectory; Pop-Location }
