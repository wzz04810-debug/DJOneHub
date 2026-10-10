@echo off
rem Prepare the Windows environment only: download platform-tools and install pyserial.
rem Nothing is written to the module by this script.
setlocal
chcp 65001 >nul 2>nul
title DJOneHub QDC507 - Prepare Windows environment
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0bootstrap.ps1" -Action setup %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (echo [DJOneHub] Environment ready.) else (echo [DJOneHub] Failed, exit code %RC%.)
echo.
pause
exit /b %RC%