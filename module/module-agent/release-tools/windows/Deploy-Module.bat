@echo off
rem DJOneHub QDC507 module - first persistent deploy (uses the author's original deployer).
rem Double-click this file. Everything below is ASCII on purpose: Chinese output comes from
rem bootstrap.ps1 / the Python scripts, which write Unicode straight to the console.
setlocal
chcp 65001 >nul 2>nul
title DJOneHub QDC507 - First Deploy
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0bootstrap.ps1" -Action deploy %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (echo [DJOneHub] First deploy finished.) else (echo [DJOneHub] Failed, exit code %RC%.)
echo.
pause
exit /b %RC%