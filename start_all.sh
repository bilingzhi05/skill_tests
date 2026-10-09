#!/usr/bin/env bash
# ============================================================
# 一键启动 Skill 评审系统（Linux / macOS）
#   Next.js 前端 : http://127.0.0.1:1237
#   FastAPI 后端 : http://127.0.0.1:1238
# 用法：
#   chmod +x start_all.sh
#   ./start_all.sh
# ============================================================
set -e

# 切到脚本所在目录（skill_tests）
cd "$(dirname "$0")"

LOG_DIR="$(pwd)/logs"
mkdir -p "$LOG_DIR"

# 兼容 python3 / python
PY=python3
command -v python3 >/dev/null 2>&1 || PY=python

echo "============================================================"
echo "  一键启动 Skill 评审系统"
echo "    后端: http://127.0.0.1:1238"
echo "    前端: http://127.0.0.1:1237"
echo "============================================================"
echo

echo "[1/2] 启动 FastAPI 后端 (端口 1238) ..."
(
  cd process_skills
  nohup "$PY" -m uvicorn server.main:app --host 127.0.0.1 --port 1238 \
    > "$LOG_DIR/backend.log" 2>&1 &
  echo $! > "$LOG_DIR/backend.pid"
)

echo "[2/2] 启动 Next.js 前端 (端口 1237) ..."
(
  cd aml_skill_review
  nohup pnpm dev > "$LOG_DIR/frontend.log" 2>&1 &
  echo $! > "$LOG_DIR/frontend.pid"
)

echo
echo "已后台启动，日志目录: $LOG_DIR"
echo "  backend.log   /  frontend.log"
echo "浏览器访问: http://127.0.0.1:1237"
echo