@echo off
chcp 65001 >nul
setlocal

echo ============================================================
echo  一键启动 Skill 评审系统
echo    Next.js 前端 : http://127.0.0.1:1237
echo    FastAPI 后端 : http://127.0.0.1:12371
echo ============================================================
echo.

echo [0/3] 检查并安装环境依赖 ...
rem 后端依赖：只有缺关键模块时才安装
python -c "import fastapi, uvicorn, yaml" >nul 2>&1
if errorlevel 1 (
  echo   后端依赖缺失，安装 server_requirements.txt ...
  python -m pip install -r "%~dp0process_skills\server_requirements.txt"
) else (
  echo   后端依赖已就绪
)
rem 前端依赖：node_modules 不存在才安装
if not exist "%~dp0aml_skill_review\node_modules" (
  echo   前端依赖缺失，执行 pnpm install ...
  pushd "%~dp0aml_skill_review"
  call pnpm install
  popd
) else (
  echo   前端依赖已就绪
)
echo.

echo [1/3] 启动 FastAPI 后端 (端口 12371) ...
start "Skill-后端" /d "%~dp0process_skills" cmd /k python -m uvicorn server.main:app --host 127.0.0.1 --port 12371

echo [2/3] 启动 Next.js 前端 (端口 1237) ...
start "Skill-前端" /d "%~dp0aml_skill_review" cmd /k pnpm dev

echo.
echo 已分别在两个新窗口启动，请等待前端编译完成。
echo 浏览器访问: http://127.0.0.1:1237
echo.
endlocal