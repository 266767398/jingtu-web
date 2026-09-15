@echo off
:: Jingtu WEB unified ops tool - thin launcher for jingtu.ps1 (Windows only)
:: Keep this file ASCII-only: cmd reads it with the OEM codepage, and the
:: BOM guard below must itself survive any editor re-save.
setlocal
chcp 65001 >nul 2>&1
title JingtuWEB Ops Tool
set "ROOT=%~dp0"
set "JINGTU_PS1=%ROOT%jingtu.ps1"

if not exist "%JINGTU_PS1%" (
    echo.
    echo  [ERROR] jingtu.ps1 not found. Expected location:
    echo          %JINGTU_PS1%
    echo  jingtu.bat and jingtu.ps1 must stay in the same folder.
    echo.
    pause
    exit /b 2
)

:: ---- BOM self-heal (must run BEFORE -File) -----------------------------
:: PowerShell 5.1 decodes a BOM-less .ps1 with the ANSI codepage, so every
:: Chinese string turns into mojibake, the script fails to parse, and the
:: window just flashes. Restore the UTF-8 BOM (EF BB BF) if it is missing.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$p=$env:JINGTU_PS1; try { $b=[System.IO.File]::ReadAllBytes($p); if ($b.Length -lt 3 -or $b[0] -ne 239 -or $b[1] -ne 187 -or $b[2] -ne 191) { $n=New-Object 'byte[]' ($b.Length + 3); $n[0]=239; $n[1]=187; $n[2]=191; [Array]::Copy($b, 0, $n, 3, $b.Length); [System.IO.File]::WriteAllBytes($p, $n); Write-Host '[FIX] jingtu.ps1 UTF-8 BOM restored' -ForegroundColor Yellow } } catch { Write-Host ('[WARN] BOM check skipped: ' + $_.Exception.Message) -ForegroundColor Yellow }"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%JINGTU_PS1%" %*
set "EXITCODE=%ERRORLEVEL%"

rem Launched by double-click (no arguments): keep the window open on failure
rem so the parse error stays readable instead of flashing away.
if "%~1"=="" if not "%EXITCODE%"=="0" pause
endlocal & exit /b %EXITCODE%
