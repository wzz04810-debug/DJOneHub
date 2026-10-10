@echo off
rem Roll back: restore the USB configuration that was saved before the write.
setlocal
chcp 65001 >nul 2>nul
title DJOneHub QDC507 - Restore USB composition
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0bootstrap.ps1" -Action usbcfg --restore %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (echo [DJOneHub] Restore finished.) else (echo [DJOneHub] Failed, exit code %RC%.)
echo.
pause
exit /b %RC%