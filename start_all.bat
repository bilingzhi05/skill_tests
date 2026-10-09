@echo off
chcp 65001 >nul
setlocal

echo ============================================================
echo  一键启动 Skill 评审系统
echo    Next.js 前端 : http://127.0.0.1:1237
echo    FastAPI 后端 : http://127.0.0.1:1238
echo ============================================================
echo.

echo [1/2] 启动 FastAPI 后端 (端口 1238) ...
start "Skill-后端" /d "%~dp0process_skills" cmd /k python -m uvicorn server.main:app --host 127.0.0.1 --port 1238

echo [2/2] 启动 Next.js 前端 (端口 1237) ...
start "Skill-前端" /d "%~dp0aml_skill_review" cmd /k pnpm dev

echo.
echo 已分别在两个新窗口启动，请等待前端编译完成。
echo 浏览器访问: http://127.0.0.1:1237
echo.
endlocal