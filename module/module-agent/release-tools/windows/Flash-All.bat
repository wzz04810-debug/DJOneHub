@echo off
rem DJOneHub QDC507 module - one-click first flash: preflight + USB composition + deploy.
rem Double-click this file. Everything here is ASCII on purpose: the Chinese output comes
rem from bootstrap.ps1 / the Python scripts, which write Unicode straight to the console.
rem
rem   Flash-All.bat            ask for confirmation, then write + reboot + deploy
rem   Flash-All.bat --yes      skip the confirmation prompt
rem   Flash-All.bat --force    rewrite the USB composition even if it already matches
rem   Flash-All.bat --port COM8
setlocal
chcp 65001 >nul 2>nul
title DJOneHub QDC507 - One-click first flash
echo [DJOneHub] One-click: read-only preflight, write USB composition, deploy agent.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0bootstrap.ps1" -Action flash %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (echo [DJOneHub] Done.) else (echo [DJOneHub] Failed, exit code %RC%.)
echo.
pause
exit /b %RC%
