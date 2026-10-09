# -*- coding: utf-8 -*-
"""
全局配置（路径 / 端口 / 内部 Token）。

所有路径相对 process_skills/ 推导；可用环境变量覆盖：
    SKILL_API_PORT       FastAPI 监听端口（默认 1238）
    SKILL_API_TOKEN      Next.js 代理与本服务之间的共享密钥
    SKILL_DIR_ROOT       skill 根目录（默认 AmlAgent/expert-skills/log_analyse_skills）
    JIRA_BOT_USERNAME 等 由 run_jql_with_skill_demo.py 的子进程继承
"""
from __future__ import annotations

import os
import secrets
from pathlib import Path

# process_skills/
HERE = Path(__file__).resolve().parent.parent
# skill_tests/
SKILL_TESTS = HERE.parent
# Rubick/（run_jql_with_skill_demo.py 的 cwd）
RUBICK_ROOT = HERE.parents[3]

# 任务执行脚本
RUNNER_SCRIPT = HERE / "run_jql_with_skill_demo.py"

# Skill 根目录
SKILL_DIR_ROOT = Path(
    os.environ.get(
        "SKILL_DIR_ROOT",
        str(RUBICK_ROOT / "AmlAgent" / "expert-skills" / "log_analyse_skills"),
    )
)

# 服务运行数据目录（gitignore）
DATA_DIR = HERE / "server_data"
RUNS_DIR = DATA_DIR / "runs"          # 每次运行的日志 / xlsx
TASKS_YAML = HERE / "skills_tasks.yaml"   # 任务定义（人可编辑）
STATE_JSON = DATA_DIR / "task_state.json"  # 运行态
OWNERS_JSON = DATA_DIR / "skill_owners.json"  # skill → owner 映射
PRESETS_JSON = DATA_DIR / "task_presets.json"  # 任务配置模板（preset）
TOKEN_FILE = DATA_DIR / ".api_token"

# 前端评审系统的 user_data 根目录（成功后复制结果用）
USER_DATA_ROOT = SKILL_TESTS / "aml_skill_review" / "data" / "user_data"

DEFAULT_MAX_CONCURRENT = 2

# FastAPI 监听地址：只绑定本机，浏览器不直接访问
HOST = os.environ.get("SKILL_API_HOST", "127.0.0.1")
PORT = int(os.environ.get("SKILL_API_PORT", "1238"))


def load_env_file() -> None:
    """把 ``skill_tests/.env`` 的键加载进 ``os.environ`` 作为兜底。

    规则：进程真实环境变量优先——已存在的键不会被 .env 覆盖；只有
    os.environ 里缺失的键才从 .env 读入（对应执行脚本 / 后端期望的
    ``JIRA_BOT_*``、``SMTP_*`` 等子进程配置）。
    """
    try:
        from dotenv import dotenv_values
    except ImportError:
        return
    candidates = [SKILL_TESTS / ".env", Path.cwd() / ".env"]
    for candidate in candidates:
        if not candidate.is_file():
            continue
        try:
            values = dotenv_values(candidate) or {}
        except Exception:
            continue
        for key, value in values.items():
            os.environ.setdefault(key, value)
        return


def get_internal_token() -> str:
    """获取内部共享 Token。

    优先取环境变量 SKILL_API_TOKEN；否则在 server_data/.api_token
    生成并持久化一个随机 Token（Next.js 侧读取同一文件）。
    """
    env_token = os.environ.get("SKILL_API_TOKEN", "").strip()
    if env_token:
        return env_token
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if TOKEN_FILE.exists():
        token = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if token:
            return token
    token = secrets.token_urlsafe(32)
    TOKEN_FILE.write_text(token, encoding="utf-8")
    return token
