#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
skill 任务统一调度器。

由 crontab 每分钟调用一次，读取 skills_tasks.yaml 中的任务配置，
对命中 cron 表达式的任务调用 run_jql_with_skill_demo.py 执行分析。

crontab 配置（一行即可）::

    * * * * * cd /home/amlogic/FAE/disk02/AutoLog/lingzhi.bi/Rubic/aml_seprime_kit/Rubick/backend/tests/skill_tests/process_skills && /home/amlogic/.pyenv/shims/python run_skills_scheduler.py >> /dev/null 2>&1

功能:
  1. 按 cron 表达式判断任务是否该执行
  2. 任务已在运行则跳过（基于 pid 锁文件，自动清理死锁）
  3. 子进程输出写入 skills_result_output/cron_run_{task}_jql_{时间}.log
  4. 分析结果 xlsx 输出到 skills_result_output/test-{task}-{时间}.xlsx
  5. 完成后按 --email 提取用户名（小写），复制结果到
     /home/amlogic/FAE/disk02/AutoLog/lingzhi.bi/aml_skill_review/data/user_data/{用户名}/
"""
import os
import shlex
import shutil
import signal
import subprocess
import sys
import time
import yaml
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

# ═══════════════════════════════════════════════════════════════════════════════
# 路径配置
# ═══════════════════════════════════════════════════════════════════════════════
_HERE = Path(__file__).resolve().parent            # process_skills/
_SKILL_TESTS = _HERE.parent                              # skill_tests 根目录
_RUBICK = _HERE.parents[3]                               # Rubick 根目录
_CONFIG_FILE = _HERE / "skills_tasks.yaml"
_OUTPUT_DIR = _HERE / "skills_result_output"        # xlsx + log + 锁文件
_LOCK_DIR = _OUTPUT_DIR / ".locks"
USER_DATA_ROOT = Path(
    _SKILL_TESTS / "aml_skill_review/data/user_data"
)
# 任务最长运行时间（秒），超过视为死锁自动清理
MAX_RUNTIME_SECONDS = 24 * 3600


def _log(msg: str) -> None:
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


# ═══════════════════════════════════════════════════════════════════════════════
# cron 表达式匹配（支持 * , - / ）
# ═══════════════════════════════════════════════════════════════════════════════
_FIELD_RANGES = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)]


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


# ═══════════════════════════════════════════════════════════════════════════════
# 任务锁（任务已在运行则跳过）
# ═══════════════════════════════════════════════════════════════════════════════
def _lock_path(task_name: str) -> Path:
    return _LOCK_DIR / f"{task_name}.lock"


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, ValueError):
        return False
    except PermissionError:
        return True


def acquire_lock(task_name: str) -> bool:
    """获取锁成功返回 True；任务仍在运行返回 False（自动清理死锁）。"""
    _LOCK_DIR.mkdir(parents=True, exist_ok=True)
    lock = _lock_path(task_name)
    if lock.exists():
        try:
            pid_s, ts_s = lock.read_text().split()
            pid, start_ts = int(pid_s), float(ts_s)
        except Exception:
            pid, start_ts = -1, 0.0
        if _pid_alive(pid) and (time.time() - start_ts) < MAX_RUNTIME_SECONDS:
            return False
        _log(f"  清理死锁: {lock.name} (pid={pid})")
        lock.unlink(missing_ok=True)
    # O_EXCL 保证原子创建，防止同分钟两个调度实例并发启动同一任务
    fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    os.write(fd, f"{os.getpid()} {time.time():.0f}\n".encode())
    os.close(fd)
    return True


def update_lock_pid(task_name: str, pid: int) -> None:
    """锁文件中记录实际运行任务的子进程 pid。"""
    _lock_path(task_name).write_text(f"{pid} {time.time():.0f}\n")


def release_lock(task_name: str) -> None:
    _lock_path(task_name).unlink(missing_ok=True)


# ═══════════════════════════════════════════════════════════════════════════════
# 执行任务
# ═══════════════════════════════════════════════════════════════════════════════
def run_task(task: dict) -> None:
    name = task["name"]
    ts = datetime.now().strftime("%m%d_%H%M%S")
    (_OUTPUT_DIR / name).mkdir(parents=True, exist_ok=True)

    output_xlsx = _OUTPUT_DIR / name / f"test-{name}-{ts}.xlsx"
    log_file = _OUTPUT_DIR / name / f"cron_run_{name}_jql_{ts}.log"

    cmd = [
        sys.executable, str(_HERE / "run_jql_with_skill_demo.py"),
        "--jql", task["jql"],
        "--output", str(output_xlsx),
        "--max_issues", str(task.get("max_issues", 0)),
    ]
    if task.get("skill"):
        cmd += ["--skill", task["skill"]]
    email = task.get("email", "")
    if email:
        cmd += ["--email", email]

    _log(f"▶ 启动任务 {name} → {log_file.name}")
    with open(log_file, "a", encoding="utf-8") as lf:
        lf.write(f"===== {datetime.now():%F %T} 任务启动 =====\n")
        lf.write(f"cmd: {' '.join(shlex.quote(c) for c in cmd)}\n")
        lf.flush()
        proc = subprocess.Popen(
            cmd, cwd=str(_RUBICK), stdout=lf, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        update_lock_pid(name, proc.pid)
        try:
            rc = proc.wait()
        except KeyboardInterrupt:
            os.killpg(proc.pid, signal.SIGTERM)
            raise
        lf.write(f"===== {datetime.now():%F %T} 任务结束 rc={rc} =====\n")
    _log(f"■ 任务 {name} 结束 rc={rc}")

    if rc == 0 and output_xlsx.exists() and email:
        filtered_xlsx = _make_filtered_xlsx(output_xlsx)
        copy_to_user_dirs(name, filtered_xlsx, email)
    elif rc != 0:
        _log(f"  ⚠ 任务 {name} 返回非零退出码，跳过结果复制")


def _make_filtered_xlsx(src_xlsx: Path) -> Path:
    """生成一个过滤副本：只保留「Final / Skill Final」列非空的行。

    规则说明：
      - 第 1 行表头必须存在，且能找到 Final 列（大小写/两侧空白不敏感）。
        常见列名：``Final`` / ``Skill Final`` / ``skill final`` / ``Final (Skill)``
        等只要包含 "final" 字样即可命中；若同时多列命中，取最左一列。
      - 从第 2 行开始，只有 Final 单元格的 ``str(value).strip()`` 非空才保留。
      - 若所有数据行都满足条件（无需过滤），直接返回原文件 ``src_xlsx``，
        不生成多余副本，减少 IO 与磁盘占用。
      - 过滤版输出路径与原文件同目录，文件名追加 ``-filtered`` 后缀，例如
        ``test-foo-0907_153000.xlsx`` → ``test-foo-0907_153000-filtered.xlsx``。
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
        user_dir = USER_DATA_ROOT / username
        try:
            user_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(output_xlsx, user_dir / output_xlsx.name)
            _log(f"  ✓ 已复制 {output_xlsx.name} → {user_dir}/")
        except Exception as e:
            _log(f"  ✗ 复制到 {user_dir}/ 失败: {e}")


# ═══════════════════════════════════════════════════════════════════════════════
# 主流程
# ═══════════════════════════════════════════════════════════════════════════════
def main() -> None:
    now = datetime.now()
    if not _CONFIG_FILE.exists():
        _log(f"配置文件不存在: {_CONFIG_FILE}")
        return
    with open(_CONFIG_FILE, encoding="utf-8") as f:
        tasks = yaml.safe_load(f).get("tasks") or []

    _OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    _LOCK_DIR.mkdir(parents=True, exist_ok=True)

    # 并行执行：同一分钟命中多个任务时，由线程池并发启动，
    # 每个任务独立取锁/运行/释放，互不阻塞。
    def _launch(task: dict) -> None:
        name = task.get("name", "").strip()
        cron_expr = task.get("cron", "").strip()
        if not name or not cron_expr or not task.get("jql"):
            _log(f"  ⚠ 跳过无效任务配置: {task}")
            return
        try:
            hit = cron_match(cron_expr, now)
        except ValueError as e:
            _log(f"  ✗ 任务 {name}: {e}")
            return
        if not hit:
            return
        if not acquire_lock(name):
            _log(f"⊘ 任务 {name} 已在运行，跳过")
            return
        try:
            run_task(task)
        except Exception as e:
            _log(f"  ✗ 任务 {name} 执行异常: {e}")
        finally:
            release_lock(name)

    with ThreadPoolExecutor(max_workers=len(tasks) if tasks else 4) as pool:
        futures = [pool.submit(_launch, task) for task in tasks]
        for fut in futures:
            fut.result()


if __name__ == "__main__":
    main()
