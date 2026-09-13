@echo off
chcp 65001 >nul
title 重走建站引导 - 重置引导数据
cd /d "%~dp0"

echo ============================================
echo   重走建站引导：重置引导专属数据
echo ============================================
echo.
echo 本操作仅清空「建站引导」的进度与草稿（setup-wizard.json），
echo 不影响站点其他已填配置（.env、数据库、上传文件等）。
echo.

if exist "..\setup-wizard.json" (
    del /f /q "..\setup-wizard.json"
    if exist "..\setup-wizard.json" (
        echo [失败] 无法删除 setup-wizard.json，可能被占用，请先关闭相关进程。
    ) else (
        echo [成功] 已重置建站引导数据。
    )
) else (
    echo [提示] 未找到 setup-wizard.json，无需重置（引导处于初始状态）。
)

echo.
echo 现在可重新访问 /setup.html 走建站引导（已配置项将自动预填，密码/密钥留空即沿用）。
echo.
pause
