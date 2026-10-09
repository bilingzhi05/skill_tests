@echo off
REM ============================================================
REM Skill 任务后端 FastAPI 服务启动脚本（Windows）
REM 用法：双击或在终端执行本 bat
REM 前置：set JIRA_BOT_USERNAME / JIRA_BOT_PASSWORD（子进程会继承）
REM ============================================================
cd /d "%~dp0"
python -m uvicorn server.main:app --host 127.0.0.1 --port 1238
