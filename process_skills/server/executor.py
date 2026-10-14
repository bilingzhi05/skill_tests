# -*- coding: utf-8 -*-
"""
任务执行器 + 调度器（单进程内后台线程，零第三方调度依赖）。

- 统一队列：所有 run（立即 / 一次性 / cron）都以 status=queued 落入
  task_state.json，调度线程按 max_concurrent_tasks 取出执行。
- 执行方式：subprocess 调 run_jql_with_skill_demo.py（cwd=Rubick 根），
  stdout 实时写日志并解析 [i/N] 更新进度。
- cron 表达式匹配与结果过滤复制逻辑（cron_match / _make_filtered_xlsx /
  copy_to_user_dirs）已内联在本文件中。
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

_PROGRESS_RE = re.compile(r"\[(\d+)/(\d+)\]")

# run_id -> Popen（内存态，用于停止）
_procs: dict[str, subprocess.Popen] = {}
_procs_lock = threading.Lock()

# 终端状态
_DONE_STATUSES = {"completed", "failed", "stopped"}


# ════════════════════════════════════════════════════════════════════════
# cron 表达式匹配（支持 * , - / ）
# ════════════════════════════════════════════════════════════════════════
_FIELD_RANGES = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)]


def _log(msg: str) -> None:
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def _field_match(field: str, value: int, lo: int, hi: int) -> bool:
    for part in field.split(","):
        part = part.strip()
        step = 1
        if "/" in part:
            part, step_s = part.split("/", 1)
            step = int(step_s)
        if part == "*":
            start, end = lo, hi
        elif "-" in part:
            a, b = part.split("-", 1)
            start, end = int(a), int(b)
        else:
            start = end = int(part)
        if start <= value <= end and (value - start) % step == 0:
            return True
    return False


def cron_match(cron_expr: str, now: datetime) -> bool:
    fields = cron_expr.split()
    if len(fields) != 5:
        raise ValueError(f"非法 cron 表达式: {cron_expr!r}")
    values = [now.minute, now.hour, now.day, now.month, now.weekday()]
    # cron 周日=0/7，python weekday() 周一=0 → 转换为周日=0
    values[4] = (values[4] + 1) % 7
    for field, value, (lo, hi) in zip(fields, values, _FIELD_RANGES):
        if not _field_match(field, value, lo, hi):
            return False
    return True


# ════════════════════════════════════════════════════════════════════════
# xlsx 结果过滤 + 复制给收件人
# ════════════════════════════════════════════════════════════════════════
def _make_filtered_xlsx(src_xlsx: Path) -> Path:
    """生成一个过滤副本：只保留「Final / Skill Final」列非空的行。

    规则说明：
      - 第 1 行表头必须存在，且能找到 Final 列（大小写/两侧空白不敏感）。
        常见列名：``Final`` / ``Skill Final`` / ``skill final`` / ``Final (Skill)``
        等只要包含 "final" 字样即可命中；若同时多列命中，取最左一列。
      - 从第 2 行开始，只有 Final 单元格的 ``str(value).strip()`` 非空才保留。
      - 若所有数据行都满足条件（无需过滤），直接返回原文件 ``src_xlsx``，
        不生成多余副本，减少 IO 与磁盘占用。
      - 过滤版输出路径与原文件同目录，文件名追加 ``-filtered`` 后缀。
      - 读取/写入失败都返回原文件，外层 shutil.copy2 继续走最安全路径。
    """
    from openpyxl import load_workbook, Workbook

    try:
        src_wb = load_workbook(str(src_xlsx))
    except Exception as e:
        _log(f"  ⚠ 载入 {src_xlsx.name} 失败，跳过过滤: {e}")
        return src_xlsx

    try:
        src_ws = src_wb.active
        max_row = src_ws.max_row or 1
        max_col = src_ws.max_column or 1

        if max_row <= 1:
            src_wb.close()
            return src_xlsx

        header_row_values = [
            (src_ws.cell(row=1, column=c).value or "") for c in range(1, max_col + 1)
        ]
        final_col = None
        for idx, h in enumerate(header_row_values):
            h_norm = str(h).strip().lower()
            if "final" in h_norm:
                final_col = idx + 1
                break
        if final_col is None:
            src_wb.close()
            _log(f"  ⚠ {src_xlsx.name} 未找到 Final 列，跳过过滤")
            return src_xlsx

        kept_rows = []
        total_data = 0
        for r in range(2, max_row + 1):
            total_data += 1
            final_val = src_ws.cell(row=r, column=final_col).value or ""
            if str(final_val).strip():
                kept_rows.append(r)

        if len(kept_rows) == total_data:
            src_wb.close()
            return src_xlsx

        dst_wb = Workbook()
        dst_ws = dst_wb.active
        dst_ws.title = getattr(src_ws, "title", "Filtered Results")

        for c in range(1, max_col + 1):
            src_cell = src_ws.cell(row=1, column=c)
            dst_cell = dst_ws.cell(row=1, column=c, value=src_cell.value)
            if src_cell.has_style:
                try:
                    dst_cell.font = src_cell.font.copy()
                    dst_cell.fill = src_cell.fill.copy()
                    dst_cell.alignment = src_cell.alignment.copy()
                    dst_cell.border = src_cell.border.copy()
                    dst_cell.number_format = src_cell.number_format
                    dst_cell.protection = src_cell.protection.copy()
                except Exception:
                    pass

        for dst_idx, src_r in enumerate(kept_rows, start=2):
            for c in range(1, max_col + 1):
                src_cell = src_ws.cell(row=src_r, column=c)
                dst_cell = dst_ws.cell(row=dst_idx, column=c, value=src_cell.value)
                try:
                    dst_cell.alignment = src_cell.alignment.copy()
                    dst_cell.number_format = src_cell.number_format
                except Exception:
                    pass

        try:
            for col_idx in range(1, max_col + 1):
                col_letter = dst_ws.cell(row=1, column=col_idx).column_letter
                dim = getattr(src_ws.column_dimensions, "get", None)
                if dim and src_ws.column_dimensions.get(col_letter):
                    dst_ws.column_dimensions[col_letter].width = (
                        src_ws.column_dimensions[col_letter].width
                    )
        except Exception:
            pass

        dst_path = src_xlsx.with_name(f"{src_xlsx.stem}-filtered{src_xlsx.suffix}")
        try:
            dst_wb.save(str(dst_path))
            _log(
                f"  ▼ 已生成过滤版 {dst_path.name}: "
                f"保留 {len(kept_rows)}/{total_data} 行（Final 非空）"
            )
            return dst_path
        except Exception as e:
            _log(f"  ⚠ 保存过滤版 {dst_path.name} 失败，回退原版: {e}")
            return src_xlsx
        finally:
            try:
                dst_wb.close()
            except Exception:
                pass
    finally:
        try:
            src_wb.close()
        except Exception:
            pass


def copy_to_user_dirs(name: str, output_xlsx: Path, email: str) -> None:
    """按 email 提取用户名（小写），复制结果到 user_data/{用户名}/ 目录。"""
    for addr in email.split(","):
        addr = addr.strip()
        if "@" not in addr:
            continue
        username = addr.split("@", 1)[0].lower()
        user_dir = config.USER_DATA_ROOT / username
        try:
            user_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(output_xlsx, user_dir / output_xlsx.name)
            _log(f"  ✓ 已复制 {output_xlsx.name} → {user_dir}/")
        except Exception as e:
            _log(f"  ✗ 复制到 {user_dir}/ 失败: {e}")


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
    run_id = storage.gen_task_id(skill)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    xlsx_name = f"{ts}_{storage.slug(skill)}.xlsx"
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
        "outputPath": str(run_dir / xlsx_name),
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


def _skill_owner_map() -> dict[str, str]:
    """构建 skill 标识（名称或相对路径）→ owner 的映射。

    任务记录只存 skill 名称（如 aml-display-debug），而 owner 存储在
    skill_owners.json（key 为 skill 相对路径）。此处同时按 skillName 与
    相对路径两种标识建立映射，保证新旧数据都能命中。
    """
    result: dict[str, str] = {}
    try:
        from . import skills_mgr
        for info in skills_mgr.list_skills("", True):
            name = str(info.get("skillName") or "").strip()
            owner = str(info.get("owner") or "").strip()
            if name and owner and name not in result:
                result[name] = owner
    except Exception as e:
        _log(f"构建 skill owner 映射失败: {e}")
    try:
        for path, row in (storage.load_owners() or {}).items():
            owner = str((row or {}).get("owner") or "").strip()
            if owner and path not in result:
                result[path] = owner
    except Exception as e:
        _log(f"加载 skill owners 失败: {e}")
    return result


def list_runs(
    owner: str,
    is_admin: bool,
    page: int = 1,
    page_size: int = 20,
    owner_filter: str = "",
    skill_filter: str = "",
    date_from: str = "",
    date_to: str = "",
) -> dict[str, Any]:
    """列出任务（按创建时间倒序），支持分页与 owner / skill / 日期范围过滤。

    返回 {items, total, page, page_size, owner_options, skill_options}：
      - items: 当前页任务（含重算后的 queuePosition）
      - total: 过滤后的总条数（供前端分页）
      - owner_options / skill_options: 当前用户可见任务中出现的去重选项（供下拉筛选）
    """
    state = storage.load_state()
    runs = _ordered_runs(state)
    if not is_admin:
        runs = [r for r in runs if r.get("owner") == owner]

    owner_f = (owner_filter or "").strip().lower()
    skill_f = (skill_filter or "").strip().lower()
    if owner_f:
        runs = [r for r in runs if str(r.get("owner", "")).strip().lower() == owner_f]
    if skill_f:
        runs = [r for r in runs if skill_f in str(r.get("skill", "")).lower()]
    if date_from:
        runs = [r for r in runs if str(r.get("createdAt", ""))[:10] >= date_from.strip()]
    if date_to:
        runs = [r for r in runs if str(r.get("createdAt", ""))[:10] <= date_to.strip()]

    total = len(runs)
    page = max(1, int(page))
    page_size = min(100, max(1, int(page_size)))
    start = (page - 1) * page_size
    items = runs[start : start + page_size]

    # 重算排队位置（基于全部排队任务，全局位置）
    queued = sorted(
        [r for r in state["runs"].values() if r["status"] == "queued"],
        key=lambda r: r.get("createdAt", ""),
    )
    pos_map = {r["id"]: i + 1 for i, r in enumerate(queued)}
    # 附加展示字段：全局队列位置 + skill owner（浅拷贝，避免污染存储的内存 dict）
    owners_by_skill = _skill_owner_map()
    items = [
        {
            **r,
            "queuePosition": pos_map.get(r["id"], 0),
            "skillOwner": owners_by_skill.get(str(r.get("skill", "")), ""),
        }
        for r in items
    ]

    # 下拉选项：基于权限可见的全量任务去重
    base = (
        list(state["runs"].values())
        if is_admin
        else [r for r in state["runs"].values() if r.get("owner") == owner]
    )
    owner_options = sorted(
        {str(r.get("owner", "")).strip() for r in base if str(r.get("owner", "")).strip()}
    )
    skill_options = sorted(
        {str(r.get("skill", "")).strip() for r in base if str(r.get("skill", "")).strip()}
    )
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "owner_options": owner_options,
        "skill_options": skill_options,
    }


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
                cur, raw_total = int(m.group(1)), int(m.group(2))
                # 进度分母 = min(最大处理条数, JQL 可分析条数)；最大处理条数为 0 表示不限制
                max_issues = int(run.get("maxIssues", 0) or 0)
                denom = min(max_issues, raw_total) if max_issues > 0 else raw_total
                shown_cur = min(cur, denom) if denom else cur
                pct = round(shown_cur / denom * 100) if denom else 0
                _patch(
                    run_id,
                    progress=pct,
                    progressTotal=denom,
                    progressMessage=f"处理第 {shown_cur}/{denom} 条",
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
            filtered = _make_filtered_xlsx(output_path)
            copy_to_user_dirs(run["name"], filtered, run["email"])
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
                if cron_match(d["cron"], now) and fired_map.get(task_id) != minute_key:
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
