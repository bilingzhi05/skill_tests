# -*- coding: utf-8 -*-
import argparse
import importlib.util
import json
import logging
import os
import sys
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple
def create_jira_client():
    """本地 Jira client 创建（与 run_jql_with_skill_demo 使用相同凭据）。

    优先使用 JIRA_BOT_* 凭据，回退到 JIRA_USERNAME / JIRA_PASSWORD。
    """
    from jira import JIRA

    server = os.environ.get("JIRA_BOT_SERVER") or os.environ.get("JIRA_SERVER", "https://jira.amlogic.com")
    username = os.environ.get("JIRA_BOT_USERNAME") or os.environ.get("JIRA_USERNAME")
    password = os.environ.get("JIRA_BOT_PASSWORD") or os.environ.get("JIRA_PASSWORD")
    if not username or not password:
        raise RuntimeError("JIRA 凭据未设置（JIRA_BOT_USERNAME/PASSWORD 或 JIRA_USERNAME/PASSWORD）")
    options = {"verify": False, "server": server, "timeout": 30}
    return JIRA(server, options=options, basic_auth=(username, password), timeout=30)


logger = logging.getLogger(__name__)
# 注意：main 函数中会重复设置 logging.basicConfig，这里只预留 logger 实例
# 避免重复配置导致重复日志输出
# 关键点：这里统一复用 multiAgentReasoning 中的 SimpleImpAgent 调用方式。
JIRA_SUMMARY_INSTRUCTIONS = """
# Role
你是 Jira 问题研判总结助手。

# Task
你需要根据输入的 Jira 信息：
- summary
- description
- comments
- root cause
- how to fix

输出一个严格结构化的分析总结，帮助工程师快速理解问题表现、根因和证据链。

# Hard Rules
1. 只能基于用户提供的 Jira 文本内容总结，禁止编造日志、文件名、行号或根因。
2. 优先使用 Root Cause / How to fix 中的信息补足结论，但不能把建议修复误写成已确认事实。
3. 输出必须使用中文。
4. 输出必须严格遵循下面的格式，不要增加额外章节、解释、前言或代码块。

# Output Format（严格 JSON）
必须只输出一个 JSON object，且仅包含以下字段：
{
  "root_cause_known": true/false,
  "jira_summary": "问题表现是如何的？根本原因是什么？"
}

# Additional Constraints
1. "root_cause_known"：如果 Jira 中能明确根因则为 true，否则为 false。
2. "jira_summary"写成 2-4 句，先写问题表现，再写根本原因；如果根因不足够明确（root_cause_known 为 false），直接说明"当前 Jira 无法明确根因"。
"""

JIRA_COMPARE_INSTRUCTIONS = """
# Role
你是“对比判定 Agent”，负责对比两段 Jira 分析结论文本的一致性与正确性。

# Task
输入包含两段文本：
1) 当前 real_result（真实生成结果）
2) 当前 agent_analysis（Log 分析内容/待验证结论）

你需要判断“agent_analysis”与“real_result”的结论关系属于以下三类之一：
- 命中根因：两者在“根本原因”层面一致（同一类根因/同一关键触发机制），并且问题表现不矛盾。
- 相关：两者在问题域/现象上有关联，但根因不一致或根因不充分一致（比如只对上现象或只对上一部分证据）。
- 错误：两者核心结论冲突，或 agent_analysis 与 real_result 的证据/描述明显不匹配（例如把蓝牙问题判成 WiFi、把硬件错误判成应用逻辑错误等）。
- 未知：两者中其中一个缺少关于问题分析的信息，导致无法判断根因是否一致。（例如没有分析内容）

# Hard Rules
1) 只能基于输入文本内容对比，禁止补充不存在的日志、设备信息或根因细节。
2) 必须给出“为什么判为该类”的理由，理由需要指出：对齐点（现象/关键日志/根因）与冲突点（若有）。
3) 输出必须使用中文。
4) 输出必须严格为 JSON（禁止 markdown、禁止代码块、禁止额外说明文字）。

# Output Format（严格 JSON）
必须只输出一个 JSON object，且仅包含以下字段：
{
  "verdict": "命中根因/相关/错误/未知",
  "reason": "2-6 句中文，说明对齐点与冲突点",
  "aligned_points": ["对齐点1", "对齐点2"],
  "conflict_points": ["冲突点1", "冲突点2"]
}

# Examples（举例说明三类判定）
【例 1：命中根因】
real_result：结论为“蓝牙无法打开，反复崩溃；关键证据包含 H/W error code:0x6；根因是控制器硬件错误导致协议栈异常。”
agent_analysis：结论为“蓝牙服务36秒内多次死亡，出现硬件错误码0x6；根因是蓝牙控制器硬件故障/驱动兼容性导致。”
输出：{"verdict":"命中根因","reason":"根因层面对齐：均指向控制器硬件错误（code:0x6）导致蓝牙不可用；现象一致：蓝牙服务反复崩溃/无法打开。","aligned_points":["硬件错误码0x6","蓝牙服务崩溃/无法打开"],"conflict_points":[]}

【例 2：相关】
real_result：结论为“蓝牙无法打开，服务崩溃；但根因倾向于系统 HAL/VINTF 配置缺失导致 HCI 服务未注册。”
agent_analysis：结论为“蓝牙控制器硬件故障（code:0x6）是根本原因。”
输出：{"verdict":"相关","reason":"现象层面对齐：都描述蓝牙不可用/服务异常；但根因不一致：real_result 偏向 HAL/VINTF 配置缺失，agent_analysis 指向控制器硬件故障（code:0x6），两者需要更多证据才能互相证实。","aligned_points":["蓝牙不可用/服务异常"],"conflict_points":["根因方向不一致：配置/注册 vs 硬件错误码0x6"]}

【例 3：错误】
real_result：结论为“WiFi 扫描失败，wpa_supplicant 无法启动，证据集中在 wlan 驱动/固件加载失败。”
agent_analysis：结论为“蓝牙控制器硬件故障（code:0x6）导致蓝牙无法打开。”
输出：{"verdict":"错误","reason":"问题域不一致：real_result 讨论 WiFi/wlan，而 agent_analysis 讨论蓝牙控制器硬件故障（code:0x6）；关键证据与根因完全不匹配。","aligned_points":[],"conflict_points":["问题域冲突：WiFi vs 蓝牙","证据/根因不匹配"]}

【例 4：未知】
real_result：结论为“WiFi 扫描失败，wpa_supplicant 无法启动，证据集中在 wlan 驱动/固件加载失败。”
agent_analysis：结论为“缺少log，无法分析出根本原因。”
输出：{"verdict":"未知","reason":"agent_analysis缺少log分析，无法得出根本原因。","aligned_points":[],"conflict_points":[]}
"""


def _normalize_str(value: Any) -> str:
    """将任意值安全转成字符串，并去除首尾空白。"""
    if value is None:
        return ""
    return str(value).strip()


def _parse_llm_json(raw: str) -> Optional[dict]:
    """
    尝试将大模型输出解析为 JSON dict。
    先直接 json.loads，失败后尝试提取第一个 {...} 片段再解析。
    解析失败返回 None，不抛异常。
    """
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        pass
    left = raw.find("{")
    right = raw.rfind("}")
    if left != -1 and right != -1 and right > left:
        try:
            return json.loads(raw[left : right + 1])
        except Exception:
            pass
    return None


def _format_field_value(value: Any) -> str:
    """
    将 Jira 字段对象格式化为可读字符串。

    兼容 Jira 常见字段类型：
    - 普通字符串
    - 带 value/name/displayName 属性的对象
    - list
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if hasattr(value, "value"):
        return _normalize_str(value.value)
    if hasattr(value, "name"):
        return _normalize_str(value.name)
    if hasattr(value, "displayName"):
        return _normalize_str(value.displayName)
    if isinstance(value, list):
        return ", ".join(_format_field_value(item) for item in value if item is not None).strip(", ")
    return _normalize_str(value)


def _truncate_text(text: str, max_chars: int, field_label: str) -> Tuple[str, bool, int]:
    """
    对单个字段做截断，并在末尾显式标明省略字符数。

    Args:
        text: 原始文本
        max_chars: 最大保留字符数
        field_label: 字段标签，用于生成截断说明
    """
    raw = text or ""
    if max_chars <= 0:
        omitted = len(raw)
        marked = f"【{field_label}已截断：省略 {omitted} 字符】" if omitted > 0 else ""
        return marked, omitted > 0, omitted
    if len(raw) <= max_chars:
        return raw, False, 0

    omitted = len(raw) - max_chars
    kept = raw[:max_chars].rstrip()
    kept += f"\n\n【{field_label}过长，已截断：省略 {omitted} 字符】"
    return kept, True, omitted


def _extract_comment_author_tokens(comment: Any) -> List[str]:
    """
    从 Jira comment 对象提取多个作者标识，用于后续过滤。

    兼容字段：
    - name
    - key
    - accountId
    - emailAddress
    - displayName
    """
    tokens: List[str] = []
    author = getattr(comment, "author", None)
    if author is None:
        return tokens

    for attr in ("name", "key", "accountId", "emailAddress", "displayName"):
        item = _normalize_str(getattr(author, attr, None))
        if item:
            tokens.append(item)
    return tokens


def _should_drop_comment_by_author(author_tokens: Sequence[str]) -> bool:
    """
    过滤指定作者的评论。

    过滤规则：
    - 精确匹配：nan.li、lingzhi.bi
    - 模糊匹配：Aml-Agent / amlagent
    """
    exact_names = {"nan.li", "lingzhi.bi"}
    fuzzy_names = {"aml-agent", "amlagent"}

    for token in author_tokens:
        low = token.lower()
        if low in exact_names:
            return True
        if low.endswith("@amlogic.com") and low.split("@", 1)[0] in exact_names:
            return True
        if any(keyword in low for keyword in fuzzy_names):
            return True
    return False


def _build_field_name_map(api) -> Dict[str, str]:
    """
    获取 Jira 字段名到字段 ID 的映射。

    Root Cause / How to fix 通常是自定义字段，字段 ID 在不同 Jira 环境中并不固定，
    所以这里必须先按名称查字段 ID，再从 issue.fields 里取值。
    """
    # 同一个 jira_api client 在批量处理多个 Jira 时，字段元数据通常不变，
    # 因此直接挂在实例上缓存即可，避免每次都远程调用 api.fields()。
    if hasattr(api, "_field_name_map_cache"):
        return api._field_name_map_cache

    mapping: Dict[str, str] = {}
    for field in api.fields():
        field_name = _normalize_str(field.get("name", "")).lower()
        field_id = _normalize_str(field.get("id", ""))
        if field_name and field_id:
            mapping[field_name] = field_id

    try:
        api._field_name_map_cache = mapping
    except Exception:
        logger.debug("jira client 不支持挂载字段映射缓存，将继续直接请求 api.fields()")

    return mapping


def _get_named_issue_field(issue: Any, field_name_map: Dict[str, str], candidate_names: Sequence[str]) -> str:
    """
    按字段展示名候选列表读取 Jira issue 中的字段值。

    Args:
        issue: jira issue 对象
        field_name_map: 字段名 -> 字段 ID 映射
        candidate_names: 候选字段名列表（忽略大小写）
    """
    for name in candidate_names:
        field_id = field_name_map.get(name.strip().lower())
        if not field_id:
            continue
        value = getattr(issue.fields, field_id, None)
        text = _format_field_value(value)
        if text:
            return text
    return ""


def _jira_issue_with_retry(jira_api, jira_key, retries=3):
    """jira_api.issue() 单点拉取：对 5xx 网关抖动额外手动重试。

    429/503/连接类错误已由库内 ResilientSession 自动重试，
    这里只补 jira 3.8 不重试的 5xx（500/502/504 等）。
    """
    import time as _t
    from jira import JIRAError

    attempt = 0
    while True:
        try:
            return jira_api.issue(jira_key)
        except JIRAError as e:
            status = getattr(e, "status_code", None)
            if status is not None and status < 500:
                raise  # 4xx 业务/权限错误不重试
            if attempt >= retries:
                raise
            attempt += 1
            delay = 10 * 2 ** (attempt - 1)
            print(f"  issue({jira_key}) 5xx 重试 [{attempt}/{retries}] status={status}，{delay}s 后重试...")
            _t.sleep(delay)


def read_jira_issue_fields(
    jira_id: str,
    jira_api,
    max_description_chars: int = 8000,
    max_comment_chars: int = 3000,
    max_root_cause_chars: int = 4000,
    max_how_to_fix_chars: int = 4000,
) -> Dict[str, Any]:
    """
    读取 Jira issue 的核心文本字段，并对超长文本按字段进行截断说明。

    读取内容包括：
    - summary
    - description
    - comments（过滤 nan.li / lingzhi.bi / Aml-Agent）
    - root cause
    - how to fix
    """
    jira_key = _normalize_str(jira_id).upper()
    
    try:
        if not jira_key:
            raise ValueError("jira_id 不能为空")
        # 这里不限制 fields，避免遗漏动态 custom field（如 Root Cause / How to fix）。
        issue = _jira_issue_with_retry(jira_api, jira_key)
    
        field_name_map = _build_field_name_map(jira_api)

        summary = _normalize_str(getattr(issue.fields, "summary", "") or "")

        description_raw = _normalize_str(getattr(issue.fields, "description", "") or "")
        description, description_truncated, description_omitted_chars = _truncate_text(
            description_raw, max_description_chars, "Description"
        )

        root_cause_raw = _get_named_issue_field(
            issue,
            field_name_map,
            ("Root Cause", "RootCause", "root cause", "rootcause"),
        )
        root_cause, root_cause_truncated, root_cause_omitted_chars = _truncate_text(
            root_cause_raw, max_root_cause_chars, "Root Cause"
        )

        how_to_fix_raw = _get_named_issue_field(
            issue,
            field_name_map,
            ("How to fix", "How To Fix", "HowToFix", "how to fix", "howtofix"),
        )
        how_to_fix, how_to_fix_truncated, how_to_fix_omitted_chars = _truncate_text(
            how_to_fix_raw, max_how_to_fix_chars, "How to Fix"
        )

        comments_out: List[Dict[str, Any]] = []
        comments_obj = getattr(issue.fields, "comment", None)
        raw_comments = getattr(comments_obj, "comments", None) if comments_obj else None
        if raw_comments:
            for comment in raw_comments:
                author_tokens = _extract_comment_author_tokens(comment)
                if _should_drop_comment_by_author(author_tokens):
                    continue

                body_raw = _normalize_str(getattr(comment, "body", "") or "")
                body, body_truncated, body_omitted_chars = _truncate_text(body_raw, max_comment_chars, "评论")
                comments_out.append(
                    {
                        "body": body,
                        "truncated": body_truncated,
                        "omitted_chars": body_omitted_chars,
                    }
                )
    except Exception as e:
        logger.error(f"读取 Jira issue {jira_key} 失败: {e}")
        return {
            "jira_id": jira_id,
            "summary": "",
            "description": "",
            "description_truncated": "",
            "description_omitted_chars": "",
            "root_cause": "",
            "root_cause_truncated": "",
            "root_cause_omitted_chars": "",
            "how_to_fix": "",
            "how_to_fix_truncated": "",
            "how_to_fix_omitted_chars": "",
            "comments": [],
        }
    
    return {
        "jira_id": jira_key,
        "summary": summary,
        "description": description,
        "description_truncated": description_truncated,
        "description_omitted_chars": description_omitted_chars,
        "root_cause": root_cause,
        "root_cause_truncated": root_cause_truncated,
        "root_cause_omitted_chars": root_cause_omitted_chars,
        "how_to_fix": how_to_fix,
        "how_to_fix_truncated": how_to_fix_truncated,
        "how_to_fix_omitted_chars": how_to_fix_omitted_chars,
        "comments": comments_out,
    }


def _build_llm_query(issue_data: Dict[str, Any], max_prompt_chars: int = 32000) -> str:
    """
    组装发给大模型的用户输入。

    说明：
    - comments 可能很多，这里会先全部拼接；
    - 如果整体 prompt 过长，再统一截断尾部，避免请求过大导致模型报错。
    """
    comment_blocks: List[str] = []
    for index, comment in enumerate(issue_data.get("comments", []), start=1):
        body = _normalize_str(comment.get("body", ""))
        if not body:
            continue
        comment_blocks.append(f"Comment {index}:\n{body}")

    comments_text = "\n\n".join(comment_blocks) if comment_blocks else "无有效评论"
    query = (
        f"Jira ID: {issue_data.get('jira_id', '')}\n\n"
        f"Summary:\n{issue_data.get('summary', '')}\n\n"
        f"Description:\n{issue_data.get('description', '')}\n\n"
        f"Root Cause:\n{issue_data.get('root_cause', '') or '无'}\n\n"
        f"How to fix:\n{issue_data.get('how_to_fix', '') or '无'}\n"
        f"Comments:\n{comments_text}\n\n"
    )

    if len(query) <= max_prompt_chars:
        return query

    omitted = len(query) - max_prompt_chars
    trimmed = query[:max_prompt_chars].rstrip()
    trimmed += f"\n\n【提示：输入内容过长，已在发送给模型前额外截断，省略 {omitted} 字符】"
    return trimmed


def _call_llm_with_retry(
    system_prompt: str,
    query: str,
    max_retries: int = 3,
    *,
    llm_client=None,
) -> str:
    """
    使用外部传入的 LLMClient 执行大模型请求。

    - 失败后最多重试 max_retries 次
    - 使用指数退避，避免瞬时网络问题

    Args:
        system_prompt: 系统提示词
        query: 用户输入
        max_retries: 最大重试次数
        llm_client: 外部传入的 LLMClient 实例（来自 backend.core.llm_client），
                    未传时自动创建。
    """
    if llm_client is None:
        from backend.core.llm_client import LLMClient
        llm_client = LLMClient()

    last_exc: Optional[Exception] = None
    for attempt in range(1, max_retries + 1):
        try:
            return llm_client.run(system_prompt=system_prompt, query=query)
        except Exception as exc:
            last_exc = exc
            logger.warning(
                "llm_judge_skill_accuracy: llm.run failed (%s/%s): %s",
                attempt,
                max_retries,
                exc,
            )
            if attempt < max_retries:
                time.sleep(min(2 ** (attempt - 1), 4))

    raise RuntimeError(f"大模型调用失败，已重试 {max_retries} 次: {last_exc}")


def compare_real_result_with_agent_analysis(
    real_result: str,
    agent_analysis: str,
    *,
    max_retries: int = 3,
    llm_client=None,
) -> Dict[str, Any]:
    """
    对比“real_result（真实生成结果）”与“agent_analysis（Log 分析内容）”的一致性，输出：相关 / 命中根因 / 错误，并给出原因。

    Args:
        real_result: 当前真实的模型输出（通常包含【结论综述/关键日志依据/详细证据链】三段）
        agent_analysis: Log 的分析内容（外部给定的参考结论/待验证结论）
        max_retries: 调用大模型失败时的最大重试次数

    Returns:
        dict:
            - verdict: 命中根因/相关/错误/未知
            - reason: 判定原因（中文）
            - aligned_points: 对齐点列表（字符串数组）
            - conflict_points: 冲突点列表（字符串数组）
            - raw: 大模型原始输出（便于排查格式不合规时的原因）
    """
    real_result = _normalize_str(real_result)
    agent_analysis = _normalize_str(agent_analysis)
    if "未能提取结论" in agent_analysis:
        agent_analysis = ""

    if not real_result or not agent_analysis:
        return {
            "verdict": "未知",
            "reason": "输入为空：real_result 或 agent_analysis 为空，无法进行对比判定。",
            "raw": "",
        }

    query = (
        "【real_result（真实结果）】\n"
        f"{real_result}\n\n"
        "【agent_analysis（Log 分析内容）】\n"
        f"{agent_analysis}\n"
    )

    try:
        raw = _call_llm_with_retry(JIRA_COMPARE_INSTRUCTIONS, query, max_retries=max_retries, llm_client=llm_client)
        raw = _normalize_str(raw)
    except Exception as exc:
        return {
            "verdict": "未知",
            "reason": f"大模型对比判定不可用（{exc}）。默认判为“未知”，建议检查根因是否一致。",
            "aligned_points": [],
            "conflict_points": [],
            "raw": "",
        }

    parsed = _parse_llm_json(raw)

    verdict = "未知"
    reason = ""
    aligned_points: List[str] = []
    conflict_points: List[str] = []

    if isinstance(parsed, dict):
        verdict = _normalize_str(parsed.get("verdict", "")) or "未知"
        reason = _normalize_str(parsed.get("reason", "")) or ""
        ap = parsed.get("aligned_points", [])
        cp = parsed.get("conflict_points", [])
        if isinstance(ap, list):
            aligned_points = [_normalize_str(x) for x in ap if _normalize_str(x)]
        if isinstance(cp, list):
            conflict_points = [_normalize_str(x) for x in cp if _normalize_str(x)]
    else:
        reason = raw

    return {
        "verdict": verdict if verdict in ("命中根因", "相关", "错误", "未知") else "未知",
        "reason": reason or raw,
        "aligned_points": aligned_points,
        "conflict_points": conflict_points,
        "raw": raw,
    }


def run_agent_analysis_judge_for_jira(
    jira_id: str,
    agent_analysis: str,
    jira_api=None,
    *,
    max_retries: int = 3,
    llm_client=None,
) -> Dict[str, Any]:
    jira_id = _normalize_str(jira_id)
    agent_analysis = _normalize_str(agent_analysis)
    
    analysis_result = {
        "jira_id": jira_id,
        "real_result": "",
        "agent_analysis": "",
        "verdict": "",
        "reason": "",
        "aligned_points": "",
        "conflict_points": "",
    }
    try:
        if not jira_id:
            raise ValueError("jira_id 为空")
        if not agent_analysis:
            raise ValueError("agent_analysis 为空")
        if "未能提取结论" in agent_analysis:
            agent_analysis = ""
        if not agent_analysis:
            analysis_result['verdict'] = "未知"
            analysis_result['reason'] = f"输入为空：agent_analysis 为空，无法进行对比判定。"
            return analysis_result
    except ValueError as exc:
        analysis_result['verdict'] = "未知"
        analysis_result['reason'] = f"输入为空：{exc}，无法进行对比判定。"
        return analysis_result
        
    if not jira_api:
        jira_api = create_jira_client()

    issue_data = analyze_jira_issue_with_llm(jira_id=jira_id, jira_api=jira_api, llm_client=llm_client)
    root_cause_known = issue_data.get("root_cause_known", None)
    # print(f"root_cause_known: {root_cause_known}")
    real_result = _normalize_str(issue_data.get("real_result", ""))
    if root_cause_known is False:
        # 真正未知根因：LLM 明确表示无法确定
        analysis_result['real_result'] = real_result
        analysis_result['agent_analysis'] = agent_analysis
        analysis_result['verdict'] = "未知"
        analysis_result['reason'] = f"当前 Jira 无法明确根因，无法进行对比判定。"
        return analysis_result
    elif root_cause_known is None:
        # LLM 输出格式错误：real_result 为原始文本，仍尝试对比
        logger.warning(f"root_cause_known 为 None（LLM 格式错误），使用原始文本继续对比。jira_id={jira_id}")
        if not real_result:
            analysis_result['real_result'] = real_result
            analysis_result['agent_analysis'] = agent_analysis
            analysis_result['verdict'] = "未知"
            analysis_result['reason'] = f"LLM 输出格式异常且无有效内容，无法进行对比判定。"
            return analysis_result

    cmp = compare_real_result_with_agent_analysis(
        real_result=real_result,
        agent_analysis=agent_analysis,
        max_retries=max_retries,
        llm_client=llm_client,
    )
    aligned_points = cmp.get("aligned_points", [])
    conflict_points = cmp.get("conflict_points", [])

    analysis_result['real_result'] = real_result
    analysis_result['agent_analysis'] = agent_analysis
    analysis_result['verdict'] = cmp.get("verdict", "")
    analysis_result['reason'] = cmp.get("reason", "")
    analysis_result['aligned_points'] = " , ".join(aligned_points)
    analysis_result['conflict_points'] = " , ".join(conflict_points)

    return analysis_result

def _default_audit_db_path() -> str:
    labeller_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(labeller_dir, "tmp", "audit_labels.db")


def analyze_jira_issue_with_llm(
    jira_id: str,
    jira_api,
    max_description_chars: int = 8000,
    max_comment_chars: int = 3000,
    max_root_cause_chars: int = 4000,
    max_how_to_fix_chars: int = 4000,
    *,
    llm_client=None,
) -> Dict[str, Any]:
    """
    输入 jira_id，读取 Jira 文本字段并调用大模型输出固定格式总结。

    Returns:
        dict:
            - jira_id
            - summary
            - description
            - root_cause
            - how_to_fix
            - comments
            - real_result
    """
    issue_data = {}
    issue_data = read_jira_issue_fields(
        jira_id=jira_id,
        jira_api=jira_api,
        max_description_chars=max_description_chars,
        max_comment_chars=max_comment_chars,
        max_root_cause_chars=max_root_cause_chars,
        max_how_to_fix_chars=max_how_to_fix_chars,
    )
    if not issue_data:
        return issue_data
    # print(f"issue_data: {issue_data}")
    llm_query = _build_llm_query(issue_data)
    # logger.info(f"llm_query: {llm_query}")
    llm_result = _call_llm_with_retry(JIRA_SUMMARY_INSTRUCTIONS, llm_query, llm_client=llm_client)
    normalized = _normalize_str(llm_result)
    # 尝试解析结构化 JSON 输出（root_cause_known + jira_summary）
    parsed_summary = _parse_llm_json(normalized)
    if parsed_summary and "jira_summary" in parsed_summary:
        issue_data["real_result"] = _normalize_str(parsed_summary.get("jira_summary", ""))
        issue_data["root_cause_known"] = parsed_summary.get("root_cause_known", None)
    else:
        # JSON 解析失败时回退到原始文本，不影响整体流程
        issue_data["real_result"] = normalized
        logger.warning(
            f"LLM 输出格式错误（非预期 JSON），回退为原始文本。jira_id={issue_data.get('jira_id', '?')}, "
            f"raw_output={normalized[:200]}"
        )
        issue_data["root_cause_known"] = None  # None 表示格式错误，区别于 False（真正未知）

    return issue_data



if __name__ == "__main__":
    agent_analysis = """
h3. AI 智能分析 - 结论综述 (For reference only)

HDMI显示闪屏问题，疑似由STR（Suspend To RAM）开关机过程中的HDCP重新认证时序或显示模块电源状态切换异常引起。

_分析 Skill: aml-display-debug_

*【所属模块】*
*Display*

*【关键日志依据】*

{code:java}
(日志文件中未提取到HDMI或显示相关的关键事件条目)
{code}

----
_[点击在线查看完整报告|https://aml-agent.amlogic.com/api/jira-analysis/report/f8fc3fd1725e402b9b8909acbf140b01]_（有效期至 2026-07-31，过期后请从上方附件下载）
_完整分析报告（含分析步骤、证据链）请查看附件：_ [^analysis_TV-227119_20260701_044828.html]
_由 [Amlagent AI|https://aml-agent.amlogic.com/] 自动生成 | 分析时间: 2026-07-01 04:48:33 CST_
_大语言模型可能会犯错。请核实重要信息。_
"""
    res = run_agent_analysis_judge_for_jira(
        jira_id="TV-227119",
        agent_analysis=agent_analysis,
    )
    print(f"res:", json.dumps(res, ensure_ascii=False, indent=2))

