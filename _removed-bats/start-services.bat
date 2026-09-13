@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM 前置检查：面板主脚本必须存在
if not exist "%~dp0start-services.ps1" (
    echo.
    echo [错误] 未找到 start-services.ps1，请检查项目完整性。
    pause
    exit /b 1
)

REM 在独立控制台窗口中运行面板：
REM  - 不再使用 start（cmd 的 start 在中文/特殊字符下解析脆弱，且 start /WAIT 的错误处理受 cmd 子进程树影响）
REM  - 改用 runas / env / start-process 通过 powershell 自身启动新控制台（最稳）
REM  - 同时保留同步运行模式作为兜底：直接 powershell.exe -File
echo 正在启动境途WEB服务增强控制面板...
echo.

REM 方案 A：让 powershell 内部用 Start-Process 启动自身新进程（独立控制台，最稳）
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%CD%\start-services.ps1' -WorkingDirectory '%CD%' -Wait -WindowStyle Normal"
set EC=%errorlevel%

if "%EC%"=="2" (
    echo.
    echo [提示] 控制面板已在另一个窗口中运行，请勿重复打开。
    pause
) else if not "%EC%"=="0" (
    echo.
    echo [错误] 控制面板异常退出（退出码 %EC%），请查看 logs\panel-audit.log 排查原因。
    pause
)
