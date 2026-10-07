@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" -Background -OpenBrowser %*
set "ODYLIC_LAUNCH_EXIT=%ERRORLEVEL%"
if not "%ODYLIC_LAUNCH_EXIT%"=="0" pause
exit /b %ODYLIC_LAUNCH_EXIT%
