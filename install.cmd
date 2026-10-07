@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "ODYLIC_INSTALL_EXIT=%ERRORLEVEL%"
if not "%ODYLIC_INSTALL_EXIT%"=="0" pause
exit /b %ODYLIC_INSTALL_EXIT%
