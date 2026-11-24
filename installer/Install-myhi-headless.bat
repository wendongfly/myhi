@echo off
chcp 65001 >nul
title myhi installer (headless)
rem Headless / always-on mode: starts at boot, no logon required. For servers / always-on PCs.
rem For an employee's own PC use Install-myhi.bat instead (starts at logon).
rem "am_admin" marker prevents an infinite UAC loop if "net session" misdetects admin rights.
if "%~1"=="am_admin" goto :run
net session >nul 2>&1
if %errorlevel%==0 goto :run
echo [myhi] Requesting administrator (UAC)...
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList 'am_admin' -Verb RunAs"
exit /b
:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-myhi.ps1" -Headless
echo.
echo Done. You can close this window.
pause
