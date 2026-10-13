#!/usr/bin/env bash
# ============================================================
# 一键关闭 Skill 评审系统（Linux / macOS / Git Bash(Windows)）
# 用法：
#   chmod +x stop_all.sh
#   ./stop_all.sh
# ============================================================
set -e

cd "$(dirname "$0")"

echo "============================================================"
echo "  一键关闭 Skill 评审系统 (端口 1237 / 12371)"
echo "============================================================"
echo

# Git Bash / MSYS 下：后端/前端是 Windows 原生进程（python.exe / node.exe），
# pkill / fuser 匹配不到，改走 netstat + taskkill。
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*)
    echo "[1/2] 关闭 FastAPI 后端 (端口 12371) ..."
    for P in 12371 1237; do
      [ "$P" = "1237" ] && echo "[2/2] 关闭 Next.js 前端 (端口 1237) ..."
      FOUND=0
      for PID in $(netstat -ano | grep ":${P} " | grep "LISTENING" | awk '{print $NF}' | sort -u); do
        echo "  结束进程 PID $PID"
        taskkill //F //T //PID "$PID" >/dev/null 2>&1 && FOUND=1
      done
      [ "$FOUND" = "1" ] && echo "  已关闭 (端口 $P)" || echo "  未在运行 (端口 $P)"
    done
    ;;
  *)
    echo "[1/2] 关闭 FastAPI 后端 (端口 12371) ..."
    pkill -f 'uvicorn server.main:app' 2>/dev/null && echo "  已关闭" || echo "  未在运行"

    echo "[2/2] 关闭 Next.js 前端 (端口 1237) ..."
    pkill -f 'next dev -p 1237' 2>/dev/null && echo "  已关闭" || echo "  未在运行"

    # 兜底：按端口强制结束（pkill 未覆盖到的残留进程）
    fuser -k 12371/tcp 2>/dev/null || true
    fuser -k 1237/tcp 2>/dev/null || true
    ;;
esac

# 清理 pid 文件
rm -f logs/backend.pid logs/frontend.pid

echo
echo "完成。"
echo