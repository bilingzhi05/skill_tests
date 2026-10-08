#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
批量 JQL 查询 + 逐条 AI 分析 + 结果导出 Excel。

用法::

    python run_jql_with_skill.py
    python run_jql_with_skill.py --jql "project = OTT AND type = Bug"
    python run_jql_with_skill.py --jql "project = OTT AND type = Bug" --output result.xlsx --max-issues 10

环境变量:
    JIRA_BOT_USERNAME / JIRA_BOT_PASSWORD — Jira 凭据
    JIRA_BOT_SERVER                       — Jira 服务器地址（默认 https://jira.amlogic.com）
     RUN_JQL_QUERY                         — JQL 查询语句（--jql 优先级更高）
    BATCH_ANALYSIS_EMAIL                   — 收件人邮箱（逗号分隔，--email 优先级更高）
    SMTP_HOST / SMTP_PORT                  — SMTP 服务器地址和端口（默认 mail-sh.amlogic.com:587）
    SMTP_USERNAME / SMTP_PASSWORD          — SMTP 登录凭据
    SMTP_SENDER                            — 发件人地址（默认同 SMTP_USERNAME）
"""
import argparse
import asyncio
import logging
import os
import sys
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path

# ═══════════════════════════════════════════════════════════════════════════════
# 0. 路径设置
# ═══════════════════════════════════════════════════════════════════════════════
_HERE = Path(__file__).resolve().parent
_RUBICK = _HERE.parents[3]
_PROJECT = _RUBICK.parent
_AMLAGENT = _RUBICK / "AmlAgent"

for _p in [str(_RUBICK), str(_AMLAGENT), str(_HERE)]:
    if _p not in sys.path:
        sys.path.insert(0, _p)

# ═══════════════════════════════════════════════════════════════════════════════
# 1. Mock 缺失的可选依赖
# ═══════════════════════════════════════════════════════════════════════════════
from unittest.mock import MagicMock

_OPTIONAL_DEPS = [
    "jose", "jose.jwt",
    "passlib", "passlib.context", "passlib.hash",
    "ldap3",
    "psycopg2", "psycopg2.extensions",
    "smolagents", "litellm", "litellm.types",
    "apscheduler", "apscheduler.triggers", "apscheduler.triggers.cron",
    "apscheduler.schedulers", "apscheduler.schedulers.background",
    "pytz",
]
for _mod_name in _OPTIONAL_DEPS:
    if _mod_name not in sys.modules:
        sys.modules[_mod_name] = MagicMock()


import re

illegal = re.compile(r'[\x00-\x08\x0B-\x0C\x0E-\x1F]')

def clean_excel(val):
    if val is None:
        return ""
    if not isinstance(val, str):
        val = str(val)
    return illegal.sub("", val)
# ═══════════════════════════════════════════════════════════════════════════════
# 2. Import 业务模块
# ═══════════════════════════════════════════════════════════════════════════════
import backend.api.jira_analysis_for_skills as ja
# 每次要手动更新jira_analysis到 jira_analysis_for_skills.py
import backend.api.batch_jql_runner as batch

# 结论对比判定（agent 分析 vs Jira 真实根因），移植自 pmlist_niko_labeller
try:
    from llm_judge_agent_comment_accuracy import run_agent_analysis_judge_for_jira
    _JUDGE_AVAILABLE = True
except Exception as _judge_import_err:  # pragma: no cover
    run_agent_analysis_judge_for_jira = None
    _JUDGE_AVAILABLE = False
    print(f"  WARN: judge 模块导入失败，将跳过结论判定: {_judge_import_err}")

# ═══════════════════════════════════════════════════════════════════════════════
# 3. Windows UTF-8 编码修复（同 demo_debug_jira.py）
# ═══════════════════════════════════════════════════════════════════════════════
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

_orig_sh_init = logging.StreamHandler.__init__

def _utf8_sh_init(self, stream=None):
    if stream is None:
        stream = sys.stderr
    try:
        enc = getattr(stream, "encoding", "") or ""
        if enc.lower() in ("gbk", "cp936", "cp950", "cp1252", "cp932"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    _orig_sh_init(self, stream)

logging.StreamHandler.__init__ = _utf8_sh_init

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("batch_analysis")

CST = timezone(timedelta(hours=8))

# ═══════════════════════════════════════════════════════════════════════════════
# 4. 辅助函数
# ═══════════════════════════════════════════════════════════════════════════════

def _ts() -> str:
    return datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S CST")


def _section(title: str):
    print(f"\n{'─' * 60}")
    print(f"  [{_ts()}] {title}")
    print(f"{'─' * 60}")


def _lookup_custom_fields(jira_client):
    """查找 Root Cause 和 How to fix 对应的 customfield ID。"""
    field_ids = {}
    all_fields = jira_client.fields()
    for field in all_fields:
        name = field.get("name", "").strip().lower()
        if name == "root cause":
            field_ids["root_cause"] = field["id"]
        elif name == "how to fix":
            field_ids["how_to_fix"] = field["id"]
    return field_ids


def _search_issues_with_retry(jira_client, jql, start_at, max_results, fields, retries=3):
    """search_issues 分页调用：对 5xx 网关抖动额外手动重试。

    429/503/连接类错误已由库的 ResilientSession 自动重试，
    这里只补 jira 3.8 不重试的 5xx（500/502/504 等）。
    """
    import time as _t
    from jira import JIRAError

    attempt = 0
    while True:
        try:
            return jira_client.search_issues(
                jql, startAt=start_at, maxResults=max_results,
                fields=fields,
            )
        except JIRAError as e:
            status = getattr(e, "status_code", None)
            if status is not None and status < 500:
                raise  # 4xx 及以下业务错误不重试
            if attempt >= retries:
                raise
            attempt += 1
            delay = 10 * 2 ** (attempt - 1)
            print(f"  search_issues 5xx 重试 [{attempt}/{retries}] status={status}，{delay}s 后重试...")
            _t.sleep(delay)


def _get_custom_field_value(issue, field_id: str) -> str:
    """从 Jira issue 对象中提取自定义字段值。"""
    value = getattr(issue.fields, field_id, None)
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if hasattr(value, "value"):
        return str(value.value)
    if hasattr(value, "name"):
        return str(value.name)
    if isinstance(value, list):
        parts = []
        for v in value:
            if v is None:
                continue
            if hasattr(v, "value"):
                parts.append(str(v.value))
            elif hasattr(v, "name"):
                parts.append(str(v.name))
            else:
                parts.append(str(v))
        return ", ".join(parts)
    return str(value)


def _build_fields_string(base_fields: str, extra_ids: list[str]) -> str:
    """将额外 customfield ID 追加到 fields 参数中。"""
    ids = [f.strip() for f in extra_ids if f.strip()]
    if not ids:
        return base_fields
    return base_fields + "," + ",".join(ids)


def _load_or_create_workbook(output_path: str, headers: list[str]):
    """加载已有 Excel（追加行）或新建一个，返回 (wb, ws, processed_ids, next_row)。"""
    from openpyxl import load_workbook, Workbook
    from openpyxl.styles import Font, Alignment, PatternFill

    if os.path.exists(output_path):
        try:
            wb = load_workbook(output_path)
            ws = wb.active
            existing = set()
            max_row = ws.max_row
            for r in range(2, max_row + 1):
                val = ws.cell(row=r, column=1).value
                if val is not None:
                    existing.add(str(val).strip())
            logger.info("载入已有 %s，已有 %d 条记录", output_path, len(existing))
            # 同步表头：兼容老文件新增列（如 SKILL定位Owner 等三列）
            for col_idx, h in enumerate(headers, 1):
                if ws.cell(row=1, column=col_idx).value != h:
                    ws.cell(row=1, column=col_idx, value=h)
            return wb, ws, existing, max_row + 1
        except Exception as e:
            logger.warning("读取 %s 失败 (%s)，将新建文件", output_path, e)

    wb = Workbook()
    ws = wb.active
    ws.title = "Jira Analysis Results"
    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill(start_color="1E3A8A", end_color="1E3A8A", fill_type="solid")
    for col_idx, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col_idx, value=h)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center")
    return wb, ws, set(), 2


_SKILL_MODULE_LABELS = ("HDMITX", "DRM", "HWC", "其他")


def _normalize_skill_module(resp: str) -> str:
    """把大模型返回文本归一化为 HWC / DRM / HDMITX / 其他 四者之一。"""
    if not resp:
        return ""
    s = resp.strip().lower()
    for label in _SKILL_MODULE_LABELS:
        if label.lower() in s:
            return label
    return ""


def _classify_skill_owner(text) -> str:
    """用大模型判定 Skill Raw 归属模块：HWC / DRM / HDMITX / 其他 四选一。"""
    if not text:
        return ""
    text = str(text).strip()
    if not text:
        return ""

    query = text[:8000]
    system_prompt = (
        "你是 Amlogic 显示驱动问题归类器。阅读给定的 Skill Raw 分析内容，"
        "判断该问题归属于哪个模块，只能从以下四项中选一个：HWC、DRM、HDMITX、其他。\n"
        "判定规则：\n"
        "- HWC：涉及 hwc / hardware composer / 图层合成 / SurfaceFlinger。\n"
        "- DRM：涉及 drm / KMS / CRTC / encoder / connector / atomic commit。\n"
        "- HDMITX：涉及 hdmi 发送 / hdmitx / EDID / HPD / hdmi 输出。\n"
        "- 其他：以上都不明显时选其他。\n"
        "只输出 HWC、DRM、HDMITX、其他 四者之一，不要输出任何解释或标点。"
    )
    try:
        from backend.core.llm_client import LLMClient

        llm = LLMClient()
        resp = llm.run(
            system_prompt=system_prompt,
            query=query,
            max_tokens=16,
            temperature=0,
        )
    except Exception as e:
        logger.warning("SKILL定位Owner 判定失败: %s", e)
        return ""

    return _normalize_skill_module(resp)


def _get_issue_component_names(issue) -> str:
    """从 Jira issue 提取 Component 名称列表，逗号分隔。"""
    comps = getattr(issue.fields, "components", None) or []
    names = [getattr(c, "name", "") or "" for c in comps]
    return ", ".join(n for n in names if n)


def _get_issue_assignee(issue) -> str:
    """从 Jira issue 提取 Assignee 显示名。"""
    return getattr(getattr(issue.fields, "assignee", None), "displayName", "") or ""


def _save_workbook_atomic(wb, output_path: str) -> None:
    """原子保存 Excel：先写临时文件再 os.replace 替换，写坏不污染正式文件。

    出错时抛带 errno 的异常（不再静默吞掉），日志可区分 ENOSPC/EIO/EDQUOT。
    """
    import errno as _errno

    tmp_path = output_path + ".tmp"
    try:
        wb.save(tmp_path)
        os.replace(tmp_path, output_path)
    except Exception as e:
        eno = getattr(e, "errno", None)
        why = f" (errno={eno}: {_errno.errorcode.get(eno, '?')})" if eno else ""
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass
        raise RuntimeError(f"保存 Excel 到 {output_path} 失败{why}: {e}") from e


def _send_email_with_excel(
    recipients: list[str],
    cc_list: list[str],
    subject: str,
    body: str,
    attachment_path: str,
) -> bool:
    """发送带 Excel 附件的邮件。失败返回 False，不抛异常。

    所有 SMTP 配置从环境变量读取（不硬编码密钥）：
        SMTP_HOST / SMTP_PORT / SMTP_USERNAME / SMTP_PASSWORD / SMTP_SENDER
    """
    smtp_host = os.environ.get("SMTP_HOST", "mail-sh.amlogic.com")
    smtp_port = int(os.environ.get("SMTP_PORT", "587"))
    smtp_user = os.environ.get("SMTP_USERNAME", "lingzhi.bi@amlogic.com")
    smtp_pass = os.environ.get("SMTP_PASSWORD", "Qwer!234567")
    smtp_sender = os.environ.get("SMTP_SENDER", smtp_user)

    if not smtp_user or not smtp_pass:
        logger.warning("SMTP_USERNAME / SMTP_PASSWORD 未设置，跳过邮件发送")
        return False

    try:
        from email.mime.multipart import MIMEMultipart
        from email.mime.text import MIMEText
        from email.mime.application import MIMEApplication
        from email.header import Header
        import smtplib

        msg = MIMEMultipart()
        msg["Subject"] = Header(subject, "utf-8")
        msg["From"] = smtp_sender
        msg["To"] = ", ".join(recipients)
        if cc_list:
            msg["Cc"] = ", ".join(cc_list)

        msg.attach(MIMEText(body, "plain", "utf-8"))

        with open(attachment_path, "rb") as f:
            part = MIMEApplication(f.read(), _subtype="xlsx")
            part.add_header("Content-Disposition", "attachment", filename=os.path.basename(attachment_path))
            msg.attach(part)

        smtp = smtplib.SMTP(smtp_host, smtp_port)
        smtp.ehlo()
        smtp.starttls()
        smtp.ehlo()
        smtp.login(smtp_user, smtp_pass)

        all_recipients = recipients + cc_list
        smtp.sendmail(smtp_sender, all_recipients, msg.as_string())
        smtp.quit()
        logger.info("邮件发送成功 → %s (CC: %s)", recipients, cc_list)
        return True
    except Exception as e:
        logger.warning("邮件发送失败: %s", e)
        return False


# ═══════════════════════════════════════════════════════════════════════════════
# 5. 参数解析
# ═══════════════════════════════════════════════════════════════════════════════
def parse_args():
    p = argparse.ArgumentParser(
        description="批量 JQL 查询 + AI 分析 + Excel 导出",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("--jql", default=None, help="JQL 查询语句，默认使用 batch_jql_runner._DEFAULT_JQL")
    p.add_argument("--output", default="jira_analysis_results.xlsx", help="输出 Excel 路径")
    p.add_argument("--max_issues", type=int, default=0, help="最多送 AI 分析的条数（0=不限制）")
    p.add_argument("--max_rounds", type=int, default=None, help="Agent 最大步数")
    p.add_argument("--timeout", type=int, default=None, help="单条分析超时（秒）")
    p.add_argument("--email", default=None, help="收件人邮箱（逗号分隔），也支持环境变量 BATCH_ANALYSIS_EMAIL")
    p.add_argument("--skill", default=None, help="分析所使用的技能(skill)名称")
    return p.parse_args()


# ═══════════════════════════════════════════════════════════════════════════════
# 6. 主流程
# ═══════════════════════════════════════════════════════════════════════════════
#cd /home/amlogic/FAE/disk02/AutoLog/lingzhi.bi/Rubic/aml_seprime_kit/Rubick && /home/amlogic/.pyenv/shims/python -m backend.tests.run_jql_with_skill_Nagracas --jql 'issuetype = Bug AND status = Closed AND "Root Cause" is not EMPTY AND "How to fix" is not EMPTY AND attachments is not EMPTY AND labels in (FAE-F-M-CAS-Nagra, FAE-A-M-CAS-Nagra) AND assignee in (Minhong.Yang, chao.yin, Chengshun.Wang) order by updated DESC' --output test-Nagracas-$(date +\%m\%d_\%H\%M\%S).xlsx --max_issues 0 --email "Minhong.Yang@amlogic.com" >> ~/cron_run_Nagracas_jql_$(date +\%m\%d_\%H\%M\%S).log 2>&1
#cd /home/amlogic/FAE/disk02/AutoLog/lingzhi.bi/Rubic/aml_seprime_kit/Rubick && /home/amlogic/.pyenv/shims/python -m backend.tests.run_jql_with_skill_Nagracas --jql 'key = OTT-98506' --output test-lingzhi-$(date +\%m\%d_\%H\%M\%S).xlsx --max_issues 0 --email "lingzhi.bi@amlogic.com" >> ~/cron_run_lingzhitest_jql_$(date +\%m\%d_\%H\%M\%S).log 2>&1

async def main():
    args = parse_args()

    # ── 覆盖配置 ──
    if args.timeout is not None:
        ja._ANALYSIS_TIMEOUT_SECONDS = args.timeout
    if args.max_rounds is not None:
        ja._JIRA_ANALYSIS_MAX_ROUNDS = args.max_rounds

    # ── JQL ──
    jql = args.jql or os.environ.get("RUN_JQL_QUERY") or batch._DEFAULT_JQL
    print(f"  JQL: {jql}")
    print(f"  输出: {args.output}")

    # ── 凭证 ──
    credentials = ja._get_bot_credentials()
    if not credentials["username"] or not credentials["password"]:
        print("  ERROR: JIRA_BOT_USERNAME / JIRA_BOT_PASSWORD 未设置")
        sys.exit(1)
    print(f"  Jira: {credentials['username']}@{credentials['server']}")

    # ── 连接 Jira 并查找自定义字段 ID ──
    _section("连接 Jira & 查找自定义字段")
    from jira import JIRA
    jira_client = JIRA(
        server=credentials["server"],
        basic_auth=(credentials["username"], credentials["password"]),
        # 连接 5s / 读 120s 超时；瞬时网络错误自动重试 3 次
        timeout=(5, 120),
        max_retries=3,
    )
    cf_map = _lookup_custom_fields(jira_client)
    root_cause_id = cf_map.get("root_cause", "")
    how_to_fix_id = cf_map.get("how_to_fix", "")
    print(f"  Root Cause field ID: {root_cause_id or '(未找到)'}")
    print(f"  How to fix field ID: {how_to_fix_id or '(未找到)'}")

    # ── 批量查询 Jira issues ──
    _section("查询 Jira issues")
    base_fields = "key,summary,description,labels,attachment,comment,components,assignee,customfield_10407,customfield_11005,customfield_10300"
    fields_with_custom = _build_fields_string(base_fields, [root_cause_id, how_to_fix_id])

    max_results = 5000
    page_size = 100
    raw = []
    start_at = 0

    while start_at < max_results:
        batch_issues = _search_issues_with_retry(
            jira_client, jql, start_at, page_size,
            fields=fields_with_custom,
        )
        if not batch_issues:
            break
        raw.extend(batch_issues)
        start_at += len(batch_issues)
        print(f"  已拉取 {len(raw)} 条...")
        if len(batch_issues) < page_size:
            break

    was_truncated = len(raw) > max_results
    if was_truncated:
        raw = raw[:max_results]

    if not raw:
        print("  无匹配 issue")
        return

    print(f"  共 {len(raw)} 条（{'已截断至 max_results' if was_truncated else '完整'}）")

    # ── 逐条处理 ──
    from openpyxl.styles import Alignment

    headers = [
        "Jira ID", "Summary", "Description", "Root Cause", "How to Fix", "Raw", "Final",
        "Judge Verdict", "Judge Reason", "Judge Aligned", "Judge Conflict", "Judge Real Result",
        "SKILL定位Owner", "JIRA Component", "JIRA Assignee Owner",
    ]
    wb, ws, processed_ids, row_idx = _load_or_create_workbook(args.output, headers)

    total = len(raw)
    analysis_count = 0
    success_count = 0
    fail_count = 0
    no_attachment_count = 0

    loop = asyncio.get_running_loop()

    for idx, issue in enumerate(raw, 1):
        key = issue.key

        # ── 断点续跑：跳过已有记录 ──
        if key in processed_ids:
            print(f"  [{idx}/{total}] ⊘ {key} 已分析过，跳过")
            continue

        print(f"\n  [{idx}/{total}] 处理 {key} ...")

        # ── 获取 Jira issue 完整信息（含附件下载） ──
        try:
            jira_info = batch._get_jira_issue_info(key, issue=issue)
        except Exception as e:
            logger.warning("  _get_jira_issue_info(%s) 失败: %s", key, e)
            jira_info = {"failed": True, "error": str(e), "jira_id": key}

        # ── 提取 Extra 字段 ──
        summary = getattr(issue.fields, "summary", "") or ""
        description = getattr(issue.fields, "description", "") or ""
        root_cause = _get_custom_field_value(issue, root_cause_id) if root_cause_id else ""
        how_to_fix = _get_custom_field_value(issue, how_to_fix_id) if how_to_fix_id else ""

        # ── 决定是否执行 AI 分析 ──
        final = ""
        raw_output = ""
        if jira_info.get("failed"):
            logger.warning("  跳过 %s：info 获取失败 (%s)", key, jira_info.get("error"))
            fail_count += 1
        elif not jira_info.get("has_attachment", False):
            print(f"  ⊘ {key} 无附件，跳过分析")
            no_attachment_count += 1
        elif args.max_issues > 0 and analysis_count >= args.max_issues:
            print(f"  ⊘ 已达 AI 分析上限 ({args.max_issues})，终止遍历"
                  f"（剩余 {total - idx} 条未处理）")
            break
        else:
            run_id = uuid.uuid4().hex[:8]
            work_dir = os.path.join(str(_RUBICK), "workspace", f"jira_analysis_{key}_{run_id}")
            os.makedirs(work_dir, exist_ok=True)
            ja._register_jira_workspace(work_dir)

            # 把预下载附件复制进 session workspace 并改写 info_text 中的路径，
            # 必须在拼 prompt 之前调用（否则 info_text 里仍是 jira_cache 路径，
            # 会被 BashTool 安全守卫拦截）
            try:
                ja._sync_attachments_into_workspace(jira_info, work_dir)
            except Exception as e:
                logger.warning("  %s 附件同步 workspace 失败: %s", key, e)

            try:
                attachment_hint = (
                    "该 Jira 有日志附件，请获取附件日志并完成根因分析。"
                    if jira_info.get("has_attachment", False) else
                    "该 Jira 无明显日志附件，请根据描述信息进行根因分析。"
                )
                info_text = jira_info.get("info_text", "")
                prompt = (
                    f"请分析 Jira issue {key}，{attachment_hint}"
                    f"按规定格式输出结论综述、关键日志依据、详细证据链。"
                    f"证据充分后必须立即输出最终报告，不要继续无意义的日志搜索。\n\n"
                    f"以下是 Jira 预获取信息供参考：\n{info_text}。"
                )
                if args.skill:
                    prompt += f"\n\n**要求**:使用{args.skill}这个技能进行分析"
                wifi_prompt = prompt
                _result, _raw, _skills, _synth, _hit_max = await asyncio.wait_for(
                    loop.run_in_executor(
                        ja._jira_analysis_executor,
                        ja._run_analysis_sync_with_info,
                        jira_info,
                        credentials,
                        work_dir,
                        run_id,
                        wifi_prompt
                    ),
                    timeout=ja._ANALYSIS_TIMEOUT_SECONDS,
                )
                final = _result or ""
                raw_output = _raw or ""
                analysis_count += 1
                if final:
                    success_count += 1
                    print(f"  ✓ {key} 分析完成 (final={len(final)}ch, raw={len(raw_output)}ch)")
                else:
                    print(f"  ⚠ {key} 返回空结果")
                    fail_count += 1
            except asyncio.TimeoutError:
                print(f"  ✗ {key} 超时 (>{ja._ANALYSIS_TIMEOUT_SECONDS}s)")
                fail_count += 1
            except Exception as e:
                print(f"  ✗ {key} 异常: {e}")
                fail_count += 1
            finally:
                ja._unregister_jira_workspace(work_dir)

        # ── 结论对比判定：agent 分析结论 vs Jira 真实根因 ──
        judge_verdict = judge_reason = judge_aligned = judge_conflict = judge_real = ""
        if final and _JUDGE_AVAILABLE:
            try:
                judge_res = run_agent_analysis_judge_for_jira(
                    jira_id=key,
                    agent_analysis=final,
                    jira_api=jira_client,
                )
                judge_verdict = judge_res.get("verdict", "")
                judge_reason = judge_res.get("reason", "")
                judge_aligned = judge_res.get("aligned_points", "")
                judge_conflict = judge_res.get("conflict_points", "")
                judge_real = judge_res.get("real_result", "")
                print(f"  ⚖ {key} judge={judge_verdict}")
            except Exception as e:
                logger.warning("  judge(%s) 失败: %s", key, e)

        # ── 写入 Excel 行并即时保存 ──
        row_data = [
            key, summary, description, root_cause, how_to_fix, raw_output, final,
            judge_verdict, judge_reason, judge_aligned, judge_conflict, judge_real,
            # display skill 特有：SKILL 定位 Owner（大模型判定 Skill Raw 归属模块）、Jira 字段 Owner
            _classify_skill_owner(raw_output),
            _get_issue_component_names(issue),
            _get_issue_assignee(issue),
        ]
        for col_idx, val in enumerate(row_data, 1):
            cell = ws.cell(row=row_idx, column=col_idx, value=clean_excel(val))
            cell.alignment = Alignment(wrap_text=True, vertical="top")
        _save_workbook_atomic(wb, args.output)
        row_idx += 1

    # 自适应列宽（基于前 100 行采样）
    _auto_column_width(ws, max_row=min(row_idx, 101))
    _save_workbook_atomic(wb, args.output)
    print(f"\n{'=' * 60}")
    print(f"  完成！成功={success_count}, 失败={fail_count}")
    print(f"  无附件跳过={no_attachment_count}, 实际分析={analysis_count}, 总计遍历={idx}")
    print(f"  结果已保存: {args.output}")
    print(f"{'=' * 60}")

    # ── 邮件发送 ──
    email_to = args.email or os.environ.get("BATCH_ANALYSIS_EMAIL", "")
    if email_to:
        recipients = [e.strip() for e in email_to.split(",") if e.strip()]
        if recipients:
            _section("发送邮件")
            cc_list = ["bilingzhi05@qq.com"]
            subject = f"[AmlAgent] Jira 批量分析结果 ({idx} 条)"
            body = (
                f"JQL: {jql}\n\n"
                f"总计遍历: {idx}\n"
                f"实际分析: {analysis_count}\n"
                f"成功: {success_count}\n"
                f"失败: {fail_count}\n"
                f"无附件跳过: {no_attachment_count}\n"
            )
            sent = _send_email_with_excel(
                recipients=recipients,
                cc_list=cc_list,
                subject=subject,
                body=body,
                attachment_path=args.output,
            )
            if sent:
                print(f"  邮件已发送至: {', '.join(recipients)}（抄送: {', '.join(cc_list)}）")
            else:
                print("  邮件发送失败，已跳过（详见日志）")


def _auto_column_width(ws, max_row: int):
    """给每个列设置一个合理的宽度。"""
    for col in ws.columns:
        col_letter = col[0].column_letter
        max_len = len(str(col[0].value or ""))
        for cell in col[1:max_row]:
            val = str(cell.value or "")
            # 中文字符按 2 倍宽度计算
            clen = sum(2 if ord(c) > 127 else 1 for c in val[:200])
            if clen > max_len:
                max_len = clen
        ws.column_dimensions[col_letter].width = min(max_len + 4, 80)


# ═══════════════════════════════════════════════════════════════════════════════
# Entry Point
# ═══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    asyncio.run(main())
