@echo off
:: Jingtu WEB unified ops tool - thin launcher for jingtu.ps1 (Windows only)
:: Usage:
::   jingtu.bat                          (interactive menu)
::   jingtu.bat status                   (service status)
::   jingtu.bat start / stop / restart
::   jingtu.bat panel-start / panel-stop / panel-restart
::   jingtu.bat start-all / stop-all / restart-all
::   jingtu.bat clean                    (kill stuck cmd windows)
::   jingtu.bat export [-OutDir <path>] [-Name <file.zip>] [-IncludeData]
:: On Linux/macOS use jingtu.sh instead (export only).
setlocal
chcp 65001 >nul 2>&1
title JingtuWEB Ops Tool
set "ROOT=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%jingtu.ps1" %*
set "EXITCODE=%ERRORLEVEL%"
endlocal & exit /b %EXITCODE%
