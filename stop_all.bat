@echo off
chcp 65001 >nul
setlocal

echo ============================================================
echo  一键关闭 Skill 评审系统 (关闭端口 1237 / 1238 进程)
echo ============================================================
echo.

for %%P in (1238 1237) do (
    echo 正在关闭端口 %%P ...
    for /f "tokens=5" %%A in ('netstat -ano ^| findstr ":%%P " ^| findstr "LISTENING"') do (
        echo   结束进程 PID %%A
        taskkill /F /T /PID %%A >nul 2>&1
    )
)

echo.
echo 完成。
echo.
pause
endlocal