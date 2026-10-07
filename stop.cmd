@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1" %*
set "ODYLIC_STOP_EXIT=%ERRORLEVEL%"
if not "%ODYLIC_STOP_EXIT%"=="0" pause
exit /b %ODYLIC_STOP_EXIT%
