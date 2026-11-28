@echo off
chcp 65001 >nul
title myhi WSL Ubuntu installer
rem "am_admin" marker prevents an infinite UAC loop if "net session" misdetects admin rights.
if "%~1"=="am_admin" goto :run
net session >nul 2>&1
if %errorlevel%==0 goto :run
echo [myhi] Requesting administrator (UAC)...
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList 'am_admin' -Verb RunAs"
exit /b
:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-wsl-ubuntu.ps1"
echo.
echo Done. You can close this window.
pause
