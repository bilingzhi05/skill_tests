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

# 兼容 python3 / python / py；优先选能 import 后端依赖的解释器，
# 跳过 Microsoft Store 占位符（WindowsApps/AppInstaller stub）。
PY=""
for cand in python python3 py; do
  cpath="$(command -v "$cand" 2>/dev/null)" || continue
  case "$cpath" in
    *WindowsApps*|*AppInstaller*) continue ;;
  esac
  [ -z "$PY" ] && PY="$cand"              # 首个可用的非 stub 解释器兜底
  if "$cand" -c "import fastapi, uvicorn, yaml" >/dev/null 2>&1; then
    break                                  # 依赖齐全，直接用
  fi
done
[ -z "$PY" ] && PY=python

echo "============================================================"
echo "  一键启动 Skill 评审系统"
echo "    后端: http://127.0.0.1:1238"
echo "    前端: http://127.0.0.1:1237"
echo "    解释器: $PY"
echo "============================================================"
echo

echo "[0/3] 检查并安装环境依赖 ..."
# ─ 后端依赖：只有缺关键模块时才安装
if "$PY" -c "import fastapi, uvicorn, yaml" >/dev/null 2>&1; then
  echo "  后端依赖已就绪 ($(command -v "$PY"))"
else
  echo "  后端依赖缺失，安装 server_requirements.txt ..."
  "$PY" -m pip install -r process_skills/server_requirements.txt
fi
# ─ 前端依赖：node_modules 不存在才安装
if [ ! -d aml_skill_review/node_modules ]; then
  echo "  前端依赖缺失，执行 pnpm install ..."
  ( cd aml_skill_review && pnpm install )
else
  echo "  前端依赖已就绪"
fi
echo

echo "[1/3] 启动 FastAPI 后端 (端口 1238) ..."
(
  cd process_skills
  nohup "$PY" -m uvicorn server.main:app --host 127.0.0.1 --port 1238 \
    > "$LOG_DIR/backend.log" 2>&1 &
  echo $! > "$LOG_DIR/backend.pid"
)

echo "[2/3] 启动 Next.js 前端 (端口 1237) ..."
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