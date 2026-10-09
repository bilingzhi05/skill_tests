# -*- coding: utf-8 -*-
"""
任务执行器 + 调度器（单进程内后台线程，零第三方调度依赖）。

- 统一队列：所有 run（立即 / 一次性 / cron）都以 status=queued 落入
  task_state.json，调度线程按 max_concurrent_tasks 取出执行。
- 执行方式：subprocess 调 run_jql_with_skill_demo.py（cwd=Rubick 根），
  stdout 实时写日志并解析 [i/N] 更新进度。
- cron 触发复用 run_skills_scheduler.cron_match；
- 成功后复用其 _make_filtered_xlsx / copy_to_user_dirs 把结果复制给收件人。
"""
from __future__ import annotations

import re
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from . import config, storage

# 复用现有 cron 匹配 / 结果过滤复制逻辑（process_skills/ 在 sys.path 中）
sys.path.insert(0, str(config.HERE))
import run_skills_scheduler as legacy  # noqa: E402

_PROGRESS_RE = re.compile(r"\[(\d+)/(\d+)\]")

# run_id -> Popen（内存态，用于停止）
_procs: dict[str, subprocess.Popen] = {}
_procs_lock = threading.Lock()

# 终端状态
_DONE_STATUSES = {"completed", "failed", "stopped"}


# ════════════════════════════════════════════════════════════════════════
# 创建运行记录
# ════════════════════════════════════════════════════════════════════════
def _make_run(
    *,
    name: str,
    owner: str,
    skill: str,
    jql: str,
    max_issues: int,
    email: str,
    mode: str,
    task_id: str | None,
) -> dict[str, Any]:
    run_id = storage.gen_id("task")
    run_dir = config.RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    now = storage.now_str()
    return {
        "id": run_id,
        "name": name,
        "owner": owner,
        "skill": skill,
        "skillPath": "",
        "jql": jql,
        "maxIssues": int(max_issues or 0),
        "email": email or "",
        "mode": mode,           # immediate | once | cron
        "taskId": task_id,      # 对应 yaml 定义 id（手动任务为 None）
        "status": "queued",
        "progress": 0,
        "progressTotal": 0,
        "progressMessage": "排队中",
        "logPath": str(run_dir / "output.log"),
        "outputPath": str(run_dir / "result.xlsx"),
        "pid": None,
        "queuePosition": 0,
        "createdAt": now,
        "startedAt": None,
        "finishedAt": None,
        "error": None,
    }


def enqueue_run(run: dict[str, Any]) -> dict[str, Any]:
    def _add(state: dict[str, Any]) -> None:
        state["runs"][run["id"]] = run
    storage.mutate_state(_add)
    return run


def create_immediate_run(params: dict[str, Any], owner: str) -> dict[str, Any]:
    run = _make_run(
        name=params.get("name") or "手动任务",
        owner=owner,
        skill=params.get("skill", ""),
        jql=params.get("jql", ""),
        max_issues=int(params.get("maxIssues") or 0),
        email=params.get("email", ""),
        mode="immediate",
        task_id=None,
    )
    return enqueue_run(run)


# ════════════════════════════════════════════════════════════════════════
# 查询
# ════════════════════════════════════════════════════════════════════════
def _ordered_runs(state: dict[str, Any]) -> list[dict[str, Any]]:
    return sorted(
        state["runs"].values(), key=lambda r: r.get("createdAt", ""), reverse=True
    )


def list_runs(owner: str, is_admin: bool) -> list[dict[str, Any]]:
    state = storage.load_state()
    runs = _ordered_runs(state)
    if not is_admin:
        runs = [r for r in runs if r.get("owner") == owner]
    # 重算排队位置
    queued = sorted(
        [r for r in state["runs"].values() if r["status"] == "queued"],
        key=lambda r: r.get("createdAt", ""),
    )
    pos_map = {r["id"]: i + 1 for i, r in enumerate(queued)}
    for r in runs:
        r["queuePosition"] = pos_map.get(r["id"], 0)
    return runs


def get_run(run_id: str, owner: str, is_admin: bool) -> dict[str, Any] | None:
    state = storage.load_state()
    run = state["runs"].get(run_id)
    if not run:
        return None
    if not is_admin and run.get("owner") != owner:
        return None
    queued = sorted(
        [r for r in state["runs"].values() if r["status"] == "queued"],
        key=lambda r: r.get("createdAt", ""),
    )
    for i, q in enumerate(queued):
        if q["id"] == run_id:
            run["queuePosition"] = i + 1
            break
    return run


def get_stats(owner: str) -> dict[str, Any]:
    state = storage.load_state()
    running = [r for r in state["runs"].values() if r["status"] == "running"]
    queued = sorted(
        [r for r in state["runs"].values() if r["status"] == "queued"],
        key=lambda r: r.get("createdAt", ""),
    )
    my_pos = 0
    for i, r in enumerate(queued):
        if r.get("owner") == owner:
            my_pos = i + 1
            break
    return {
        "running": len(running),
        "queued": len(queued),
        "maxConcurrent": int(state["config"]["max_concurrent_tasks"]),
        "myRunning": sum(1 for r in running if r.get("owner") == owner),
        "myQueued": sum(1 for r in queued if r.get("owner") == owner),
        "myQueuePosition": my_pos,
    }


def get_log(run_id: str, owner: str, is_admin: bool, tail: int = 200) -> str:
    run = get_run(run_id, owner, is_admin)
    if not run:
        return ""
    p = Path(run["logPath"])
    if not p.exists():
        return ""
    text = p.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    return "\n".join(lines[-tail:])


# ════════════════════════════════════════════════════════════════════════
# 停止
# ════════════════════════════════════════════════════════════════════════
def stop_run(run_id: str, owner: str, is_admin: bool) -> bool:
    run = get_run(run_id, owner, is_admin)
    if not run or run["status"] not in ("queued", "running"):
        return False

    if run["status"] == "running":
        with _procs_lock:
            proc = _procs.get(run_id)
        if proc and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass
        elif run.get("pid"):
            # 服务重启后进程映射丢失：尝试按 pid 结束
            try:
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(run["pid"])],
                    capture_output=True,
                )
            except Exception:
                pass

    Path(run["logPath"]).parent.mkdir(parents=True, exist_ok=True)
    with open(run["logPath"], "a", encoding="utf-8") as f:
        f.write(f"\n[{storage.now_str()}] 用户手动停止任务\n")

    def _mark(state: dict[str, Any]) -> None:
        r = state["runs"].get(run_id)
        if r and r["status"] not in _DONE_STATUSES:
            r["status"] = "stopped"
            r["finishedAt"] = storage.now_str()
            r["progressMessage"] = "用户手动停止"
    storage.mutate_state(_mark)
    return True


# ════════════════════════════════════════════════════════════════════════
# 执行单个 run（在独立线程中）
# ════════════════════════════════════════════════════════════════════════
def _patch(run_id: str, **fields: Any) -> None:
    def _upd(state: dict[str, Any]) -> None:
        r = state["runs"].get(run_id)
        if r:
            r.update(fields)
    storage.mutate_state(_upd)


def _execute_run(run_id: str) -> None:
    state = storage.load_state()
    run = state["runs"].get(run_id)
    if not run or run["status"] != "running":
        return

    log_path = Path(run["logPath"])
    output_path = Path(run["outputPath"])
    log_path.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        sys.executable,
        str(config.RUNNER_SCRIPT),
        "--jql", run["jql"],
        "--output", str(output_path),
        "--max_issues", str(run.get("maxIssues", 0)),
    ]
    if run.get("skill"):
        cmd += ["--skill", run["skill"]]
    if run.get("email"):
        cmd += ["--email", run["email"]]

    creationflags = 0
    if sys.platform == "win32":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP

    with open(log_path, "a", encoding="utf-8") as lf:
        lf.write(f"===== {storage.now_str()} 任务启动 =====\n")
        lf.write("cmd: " + " ".join(cmd) + "\n")
        lf.flush()
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=str(config.RUBICK_ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=creationflags,
            )
        except Exception as e:
            lf.write(f"[启动失败] {e}\n")
            _patch(run_id, status="failed", error=str(e), finishedAt=storage.now_str())
            return

        with _procs_lock:
            _procs[run_id] = proc
        _patch(run_id, pid=proc.pid, startedAt=storage.now_str(), progressMessage="运行中")

        stopped = False
        assert proc.stdout is not None
        for line in proc.stdout:
            lf.write(line)
            lf.flush()
            m = _PROGRESS_RE.search(line)
            if m:
                cur, total = int(m.group(1)), int(m.group(2))
                pct = round(cur / total * 100) if total else 0
                _patch(
                    run_id,
                    progress=pct,
                    progressTotal=total,
                    progressMessage=f"处理第 {cur}/{total} 条",
                )
        rc = proc.wait()

        with _procs_lock:
            _procs.pop(run_id, None)

        # 用户已点停止（状态被置为 stopped）则保持 stopped
        cur_state = storage.load_state()
        cur_run = cur_state["runs"].get(run_id, {})
        if cur_run.get("status") == "stopped":
            stopped = True
            final_status = "stopped"
        else:
            final_status = "completed" if rc == 0 else "failed"

        lf.write(f"\n===== {storage.now_str()} 任务结束 rc={rc} =====\n")
        lf.flush()

    if not stopped:
        _patch(
            run_id,
            status=final_status,
            progress=100 if rc == 0 else 0,
            progressMessage="任务完成" if rc == 0 else f"任务失败 (exit {rc})",
            finishedAt=storage.now_str(),
            error=None if rc == 0 else f"exit code {rc}",
        )

    # 成功且有邮箱：生成过滤版并复制到收件人的 user_data 目录
    if final_status == "completed" and output_path.exists() and run.get("email"):
        try:
            filtered = legacy._make_filtered_xlsx(output_path)
            legacy.copy_to_user_dirs(run["name"], filtered, run["email"])
        except Exception as e:
            print(f"[executor] 结果复制失败: {e}", flush=True)


# ════════════════════════════════════════════════════════════════════════
# 调度线程：cron/once 触发 + 并发派发
# ════════════════════════════════════════════════════════════════════════
def _due_cron_and_once_runs() -> list[dict[str, Any]]:
    """检查 yaml 定义，返回本次需要入队的 run 列表。"""
    state = storage.load_state()
    fired_map: dict[str, str] = state.setdefault("cron_fired", {})
    now = datetime.now()
    minute_key = now.strftime("%Y%m%d%H%M")
    due: list[dict[str, Any]] = []
    defs_to_update: list[dict[str, Any]] = []

    for d in storage.load_task_defs():
        if not d.get("enabled", True):
            continue
        task_id = d.get("id") or d.get("name")
        trigger = d.get("trigger", "cron" if d.get("cron") else "once")
        should_fire = False

        if trigger == "cron" and d.get("cron"):
            try:
                if legacy.cron_match(d["cron"], now) and fired_map.get(task_id) != minute_key:
                    should_fire = True
            except ValueError:
                continue
        elif trigger == "once" and d.get("run_at"):
            try:
                run_at = datetime.strptime(d["run_at"], "%Y-%m-%d %H:%M")
            except ValueError:
                continue
            if now >= run_at and fired_map.get(task_id) != minute_key:
                should_fire = True

        if not should_fire:
            continue
        # 同一定义已有排队/运行中的实例则跳过（与原锁语义一致）
        busy = any(
            r.get("taskId") == task_id and r["status"] in ("queued", "running")
            for r in state["runs"].values()
        )
        if busy:
            continue

        fired_map[task_id] = minute_key
        # 兼容旧 yaml：没有 owner 字段时从第一个邮箱推导登录名
        email = d.get("email", "") or ""
        owner = d.get("owner", "") or (
            email.split("@", 1)[0].strip().lower() if "@" in email else ""
        )
        run = _make_run(
            name=d.get("name", "定时任务"),
            owner=owner,
            skill=d.get("skill", ""),
            jql=d.get("jql", ""),
            max_issues=int(d.get("max_issues") or 0),
            email=email,
            mode=trigger,
            task_id=task_id,
        )
        due.append(run)

        # 一次性任务触发后禁用
        if trigger == "once":
            d["enabled"] = False
            defs_to_update.append(d)

    if due or defs_to_update:
        def _commit(s: dict[str, Any]) -> None:
            for r in due:
                s["runs"][r["id"]] = r
        storage.mutate_state(_commit)
        for d in defs_to_update:
            storage.upsert_task_def(d)
    return due


def _cleanup_old_runs() -> None:
    cutoff = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")

    def _prune(state: dict[str, Any]) -> None:
        dead = [
            rid
            for rid, r in state["runs"].items()
            if r["status"] in _DONE_STATUSES and (r.get("finishedAt") or "") < cutoff
        ]
        for rid in dead:
            run_dir = config.RUNS_DIR / rid
            if run_dir.exists():
                shutil.rmtree(run_dir, ignore_errors=True)
            state["runs"].pop(rid, None)
    storage.mutate_state(_prune)


def _recover_stale() -> None:
    """服务启动时：上一轮 running 的 run 标记为 failed；queued 保留。"""
    def _mark(state: dict[str, Any]) -> None:
        for r in state["runs"].values():
            if r["status"] == "running":
                r["status"] = "failed"
                r["error"] = "服务重启，任务中断"
                r["finishedAt"] = storage.now_str()
    storage.mutate_state(_mark)


_started = False


def start_scheduler() -> None:
    global _started
    if _started:
        return
    _started = True
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    config.RUNS_DIR.mkdir(parents=True, exist_ok=True)
    _recover_stale()

    def _loop() -> None:
        tick = 0
        while True:
            try:
                # 1. 定时/cron 任务入队
                _due_cron_and_once_runs()
                # 2. 并发派发
                state = storage.load_state()
                max_conc = int(state["config"]["max_concurrent_tasks"])
                running = sum(
                    1 for r in state["runs"].values() if r["status"] == "running"
                )
                if running < max_conc:
                    queued = sorted(
                        [r for r in state["runs"].values() if r["status"] == "queued"],
                        key=lambda r: r.get("createdAt", ""),
                    )
                    for r in queued[: max(0, max_conc - running)]:
                        def _set_running(s: dict[str, Any], rid=r["id"]) -> None:
                            if s["runs"].get(rid, {}).get("status") == "queued":
                                s["runs"][rid]["status"] = "running"
                        storage.mutate_state(_set_running)
                        t = threading.Thread(
                            target=_execute_run, args=(r["id"],), daemon=True
                        )
                        t.start()
                # 3. 每 60 个 tick（约 30 分钟）清理一次历史
                tick += 1
                if tick % 60 == 0:
                    _cleanup_old_runs()
            except Exception as e:
                print(f"[scheduler] 调度循环异常: {e}", flush=True)
            time.sleep(2)

    threading.Thread(target=_loop, name="skill-scheduler", daemon=True).start()
    print("[scheduler] 调度线程已启动", flush=True)
