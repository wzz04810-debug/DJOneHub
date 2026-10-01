@echo off
rem Step 1 of the first deploy: write the target USB composition (usbcfg) over the AT port.
rem Without --write this is a read-only preflight: nothing is written to the module.
rem   Write-USBConfig.bat --write
rem   Write-USBConfig.bat --port COM8 --write
rem   Write-USBConfig.bat --restore          (restore the configuration saved before writing)
setlocal
chcp 65001 >nul 2>nul
title DJOneHub QDC507 - USB composition
echo [DJOneHub] No argument = read-only preflight. Add --write to actually write.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0bootstrap.ps1" -Action usbcfg %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (echo [DJOneHub] Finished.) else (echo [DJOneHub] Failed, exit code %RC%.)
echo.
pause
exit /b %RC%