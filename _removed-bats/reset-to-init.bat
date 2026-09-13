@echo off
setlocal
set "ROOT=%~dp0"
echo ============================================================
echo  境途同游 — 重置系统到初始化状态
echo ============================================================
echo  本操作将把全部 super_admin 账号降级为普通成员，
echo  之后可重新通过「安装向导」创建超级管理员。
echo  不会删除 .env、不会清空业务数据、不影响已登录会话。
echo ============================================================
choice /c YN /m "确认执行重置？[Y]是 [N]否"
if errorlevel 2 goto :cancelled
node "%ROOT%server\scripts\reset-to-init.js"
if errorlevel 1 (
  echo.
  echo 重置失败，按任意键退出。
  pause
  exit /b 1
)
echo.
echo 已完成重置，按任意键退出。
pause
exit /b 0

:cancelled
echo 已取消，未执行任何操作。
pause
endlocal
