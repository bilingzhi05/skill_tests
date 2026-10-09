# -*- coding: utf-8 -*-
"""
持久化存储层。

三件数据：
1. skills_tasks.yaml  —— 任务「定义」（cron 周期 / run_at 一次性），
   人可直接编辑；格式与原 run_skills_scheduler.py 兼容（cron/skill/jql/
   email/max_issues），新增 id/owner/enabled/trigger/run_at/created_t 字段。
2. task_state.json    —— 运行态（每次执行 run 的状态、进度、pid、日志路径）
   + 全局配置 max_concurrent_tasks + 每个 cron 任务的上次触发分钟。
3. skill_owners.json  —— skill 相对路径 → owner 的映射。

JSON 一律「临时文件 + os.replace」原子写入，避免并发/断电损坏。
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml

from . import config

# 进程内锁：FastAPI 工作线程 + 调度线程都会写 JSON/yaml
_state_lock = threading.RLock()
_yaml_lock = threading.RLock()
_owners_lock = threading.RLock()
_presets_lock = threading.RLock()


def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def gen_id(prefix: str) -> str:
    return f"{prefix}_{int(time.time() * 1000)}_{uuid.uuid4().hex[:6]}"


# ════════════════════════════════════════════════════════════════════════
# 任务定义（yaml）
# ════════════════════════════════════════════════════════════════════════
def load_task_defs() -> list[dict[str, Any]]:
    """读取全部任务定义。文件不存在或为空时返回 []。"""
    if not config.TASKS_YAML.exists():
        return []
    try:
        with open(config.TASKS_YAML, encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        defs = data.get("tasks") or []
        return [t for t in defs if isinstance(t, dict)]
    except Exception as e:
        print(f"[storage] 读取 {config.TASKS_YAML.name} 失败: {e}", flush=True)
        return []


def save_task_defs(defs: list[dict[str, Any]]) -> None:
    """把任务定义整表写回 yaml（原子写，保留中文与块样式）。"""
    with _yaml_lock:
        config.TASKS_YAML.parent.mkdir(parents=True, exist_ok=True)
        header = (
            "# ============================================================\n"
            "# Skill 任务定义（由 FastAPI 服务 + 人工共同维护）\n"
            "# 字段:\n"
            "#   id         : 系统生成的唯一 ID（请勿手工修改）\n"
            "#   name       : 任务名称\n"
            "#   owner      : 创建者登录名\n"
            "#   enabled    : 是否启用（false 则不触发；一次性任务执行后自动置 false）\n"
            "#   trigger    : cron（周期）| once（指定时间一次）\n"
            "#   cron       : 5 段 cron 表达式（trigger=cron 时生效）\n"
            "#   run_at     : 一次性执行时间 'YYYY-MM-DD HH:MM'（trigger=once 时生效）\n"
            "#   skill      : skill 名称（传给 --skill）\n"
            "#   jql        : JQL 查询语句\n"
            "#   email      : 收件人邮箱（逗号分隔，结果会复制到 user_data/<用户名>/）\n"
            "#   max_issues : 最多送 AI 分析条数（0=不限）\n"
            "#   created_t  : 创建时间\n"
            "# 注意：本服务运行时请停用原 crontab 中的 run_skills_scheduler.py，\n"
            "#       避免 cron 任务被双重触发。\n"
            "# ============================================================\n"
        )
        tmp = config.TASKS_YAML.with_suffix(".yaml.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(header)
            yaml.safe_dump(
                {"tasks": defs},
                f,
                allow_unicode=True,
                sort_keys=False,
                default_flow_style=False,
                width=1000,
            )
        os.replace(tmp, config.TASKS_YAML)


def upsert_task_def(task_def: dict[str, Any]) -> dict[str, Any]:
    """新增或更新一个任务定义（按 id）。返回写入后的定义。"""
    with _yaml_lock:
        defs = load_task_defs()
        for i, d in enumerate(defs):
            if d.get("id") == task_def["id"]:
                defs[i] = task_def
                break
        else:
            defs.append(task_def)
        save_task_defs(defs)
    return task_def


def remove_task_def(task_id: str) -> bool:
    with _yaml_lock:
        defs = load_task_defs()
        new_defs = [d for d in defs if d.get("id") != task_id]
        if len(new_defs) == len(defs):
            return False
        save_task_defs(new_defs)
    return True


# ════════════════════════════════════════════════════════════════════════
# 运行态（json）
# ════════════════════════════════════════════════════════════════════════
_DEFAULT_STATE: dict[str, Any] = {
    "config": {"max_concurrent_tasks": config.DEFAULT_MAX_CONCURRENT},
    "runs": {},          # run_id -> run 信息
    "cron_fired": {},    # task_id -> 上次触发的 "分钟键" YYYYMMDDHHMM
}


def _load_raw_state() -> dict[str, Any]:
    if not config.STATE_JSON.exists():
        return json.loads(json.dumps(_DEFAULT_STATE))
    try:
        with open(config.STATE_JSON, encoding="utf-8") as f:
            state = json.load(f)
    except Exception as e:
        print(f"[storage] 状态文件损坏，重置: {e}", flush=True)
        return json.loads(json.dumps(_DEFAULT_STATE))
    state.setdefault("config", {}).setdefault(
        "max_concurrent_tasks", config.DEFAULT_MAX_CONCURRENT
    )
    state.setdefault("runs", {})
    state.setdefault("cron_fired", {})
    return state


def load_state() -> dict[str, Any]:
    with _state_lock:
        return _load_raw_state()


def save_state(state: dict[str, Any]) -> None:
    with _state_lock:
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = config.STATE_JSON.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
        os.replace(tmp, config.STATE_JSON)


def mutate_state(fn) -> Any:
    """在锁内读取-修改-写回的统一入口。fn(state) -> 返回值。"""
    with _state_lock:
        state = _load_raw_state()
        result = fn(state)
        save_state(state)
        return result


# ════════════════════════════════════════════════════════════════════════
# Skill owner 映射（json）
# ════════════════════════════════════════════════════════════════════════
def load_owners() -> dict[str, dict[str, Any]]:
    if not config.OWNERS_JSON.exists():
        return {}
    try:
        with open(config.OWNERS_JSON, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_owners(owners: dict[str, dict[str, Any]]) -> None:
    with _owners_lock:
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = config.OWNERS_JSON.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(owners, f, ensure_ascii=False, indent=2)
        os.replace(tmp, config.OWNERS_JSON)


# ════════════════════════════════════════════════════════════════════════
# 任务配置模板（preset，json）
# ════════════════════════════════════════════════════════════════════════
def load_presets() -> list[dict[str, Any]]:
    """读取全部任务配置模板。文件缺失/损坏时返回 []。"""
    if not config.PRESETS_JSON.exists():
        return []
    try:
        with open(config.PRESETS_JSON, encoding="utf-8") as f:
            data = json.load(f)
        presets = (data or {}).get("presets") or []
        return [p for p in presets if isinstance(p, dict)]
    except Exception as e:
        print(f"[storage] 读取 {config.PRESETS_JSON.name} 失败: {e}", flush=True)
        return []


def save_presets(presets: list[dict[str, Any]]) -> None:
    """整表写回 preset（原子写）。"""
    with _presets_lock:
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = config.PRESETS_JSON.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"presets": presets}, f, ensure_ascii=False, indent=2)
        os.replace(tmp, config.PRESETS_JSON)


def add_preset(preset: dict[str, Any]) -> dict[str, Any]:
    """新增一条 preset，返回写入后的 preset。"""
    with _presets_lock:
        presets = load_presets()
        presets.append(preset)
        save_presets(presets)
    return preset


def remove_preset(preset_id: str, owner: str, is_admin: bool) -> bool:
    """删除一条 preset。仅 owner 或管理员可删。"""
    with _presets_lock:
        presets = load_presets()
        new_presets = [
            p for p in presets
            if p.get("id") != preset_id or (not is_admin and p.get("owner") != owner)
        ]
        if len(new_presets) == len(presets):
            return False
        save_presets(new_presets)
    return True
