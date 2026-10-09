#!/usr/bin/env bash
# ============================================================
# 一键关闭 Skill 评审系统（Linux / macOS）
# 用法：
#   chmod +x stop_all.sh
#   ./stop_all.sh
# ============================================================
set -e

cd "$(dirname "$0")"

echo "============================================================"
echo "  一键关闭 Skill 评审系统 (端口 1237 / 1238)"
echo "============================================================"
echo

echo "[1/2] 关闭 FastAPI 后端 (端口 1238) ..."
pkill -f 'uvicorn server.main:app' 2>/dev/null && echo "  已关闭" || echo "  未在运行"

echo "[2/2] 关闭 Next.js 前端 (端口 1237) ..."
pkill -f 'next dev -p 1237' 2>/dev/null && echo "  已关闭" || echo "  未在运行"

# 兜底：按端口强制结束（pkill 未覆盖到的残留进程）
fuser -k 1238/tcp 2>/dev/null || true
fuser -k 1237/tcp 2>/dev/null || true

# 清理 pid 文件
rm -f logs/backend.pid logs/frontend.pid

echo
echo "完成。"
echo