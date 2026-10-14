# -*- coding: utf-8 -*-
"""
Skill 目录管理。

一个 skill = 含 SKILL.md（大小写不敏感）的目录；顶层子目录为「类型组」。
与前端 lib/skills.ts 行为一致：
  - 扫描、列表（owner 过滤）、详情
  - 上传 zip 或文件夹（放到 root 下，目录名取 SKILL.md 的 name 字段）
  - 删除、设置 owner
  - 文件树、文件内容读取（含路径穿越防护）
"""
from __future__ import annotations

import os
import re
import shutil
from pathlib import Path
from typing import Any

from . import config, storage


def _parse_frontmatter(text: str) -> dict[str, str]:
    """解析 SKILL.md 头部的 `---` front matter，提取 name / description。

    兼容 description 的单行写法与 `>` / `|` 折叠块写法（缩进续行）。
    """
    t = text.lstrip("\ufeff").lstrip()
    if not t.startswith("---"):
        return {}
    lines = t.splitlines()
    result: dict[str, str] = {}
    i = 1
    n = len(lines)
    while i < n:
        line = lines[i]
        if line.strip() == "---":
            break
        m = re.match(r"^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$", line)
        if not m:
            i += 1
            continue
        key = m.group(1).lower().strip()
        if key not in ("name", "description"):
            i += 1
            continue
        rest = (m.group(2) or "").strip()
        if rest in ("", ">", ">-", ">+", "|", "|-", "|+"):
            parts: list[str] = []
            i += 1
            while i < n:
                cur = lines[i]
                if cur.strip() == "---":
                    break
                if cur.startswith(" ") or cur.startswith("\t"):
                    parts.append(cur.strip())
                    i += 1
                elif not cur.strip():
                    parts.append("")
                    i += 1
                else:
                    break
            result[key] = " ".join(x for x in parts if x).strip()
            continue
        result[key] = rest.strip().strip('"').strip("'")
        i += 1
    return result


def _read_frontmatter(skill_dir: Path) -> dict[str, str]:
    skill_md = _find_skill_md(skill_dir)
    if not skill_md:
        return {}
    try:
        return _parse_frontmatter(skill_md.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return {}


def _extract_name(skill_dir: Path) -> str:
    """返回 SKILL.md front matter 中的 name 字段（任务/列表展示用）。"""
    return _read_frontmatter(skill_dir).get("name", "").strip()


def _extract_description(skill_dir: Path) -> str:
    """返回 SKILL.md front matter 中的 description 字段（截断）。"""
    return _read_frontmatter(skill_dir).get("description", "")[:200]


def _find_skill_md(directory: Path) -> Path | None:
    if not directory.is_dir():
        return None
    for entry in directory.iterdir():
        if entry.is_file() and entry.name.upper() == "SKILL.MD":
            return entry
    return None


def _count_files(directory: Path) -> int:
    count = 0
    for root, dirs, files in os.walk(directory):
        dirs[:] = [d for d in dirs if d != "__pycache__" and not d.startswith(".")]
        count += len([f for f in files if not f.startswith(".")])
    return count


def scan_skill_dirs() -> list[str]:
    """返回所有 skill 的相对路径（/ 分隔）。"""
    root = config.SKILL_DIR_ROOT
    result: list[str] = []
    if not root.exists():
        return result

    def walk(directory: Path, rel: str) -> None:
        if _find_skill_md(directory) is not None:
            if rel:
                result.append(rel)
            return
        for entry in sorted(directory.iterdir()):
            if not entry.is_dir() or entry.name == "__pycache__" or entry.name.startswith("."):
                continue
            child_rel = f"{rel}/{entry.name}" if rel else entry.name
            walk(entry, child_rel)

    walk(root, "")
    return result


def _to_camel(skill_path: str) -> dict[str, Any]:
    full = config.SKILL_DIR_ROOT / skill_path
    parts = skill_path.split("/")
    skill_name = _extract_name(full) or parts[-1]
    skill_type = parts[0] if len(parts) > 1 else "root"
    owners = storage.load_owners()
    owner_row = owners.get(skill_path, {})
    return {
        "skillPath": skill_path,
        "skillName": skill_name,
        "skillType": skill_type,
        "owner": owner_row.get("owner", ""),
        "description": owner_row.get("description") or _extract_description(full),
        "hasSkillMd": _find_skill_md(full) is not None,
        "fileCount": _count_files(full),
        "createdAt": owner_row.get("created_t", ""),
        "updatedAt": owner_row.get("updated_t", ""),
    }


def list_skills(viewer: str, is_admin: bool, mine: bool = False) -> list[dict[str, Any]]:
    """列出 Skill。

    - mine=False：所有用户都可见全部 Skill（便于在上传前检查已有 description 触发条件）；
    - mine=True 且非管理员：只返回 owner 为当前用户的 Skill（新建任务下拉只显示自己负责的）。
    """
    items = [_to_camel(sp) for sp in scan_skill_dirs()]
    if mine and not is_admin:
        items = [info for info in items if info.get("owner") == viewer]
    return items


def assert_skill_accessible(skill_identifier: str, username: str, is_admin: bool) -> bool:
    """校验用户能否使用某个 Skill（按 skillName 或 skillPath 双标识匹配）。

    管理员可访问全部；普通用户仅当该 Skill 存在且 owner 为自己时可访问。
    空标识（部分任务未挂 Skill）视为可访问。
    """
    ident = (skill_identifier or "").strip()
    if not ident or is_admin:
        return True
    target = ident.lower()
    for sp in scan_skill_dirs():
        info = _to_camel(sp)
        candidates = (
            str(info.get("skillName") or "").lower(),
            str(info.get("skillPath") or "").lower(),
        )
        if target in candidates:
            return str(info.get("owner") or "").strip() == username
    return False


def get_skill_detail(skill_path: str, viewer: str, is_admin: bool) -> dict[str, Any] | None:
    full = config.SKILL_DIR_ROOT / skill_path
    if not full.exists():
        return None
    _ = viewer, is_admin
    return _to_camel(skill_path)


def set_skill_owner(skill_path: str, owner: str) -> bool:
    if not (config.SKILL_DIR_ROOT / skill_path).exists():
        return False
    parts = skill_path.split("/")
    full = config.SKILL_DIR_ROOT / skill_path
    owners = storage.load_owners()
    now = storage.now_str()
    row = owners.get(skill_path, {})
    row.update(
        {
            "skill_path": skill_path,
            "skill_name": _extract_name(full) or parts[-1],
            "skill_type": parts[0] if len(parts) > 1 else "root",
            "owner": owner,
            "description": row.get("description") or _extract_description(full),
            "created_t": row.get("created_t") or now,
            "updated_t": now,
        }
    )
    owners[skill_path] = row
    storage.save_owners(owners)
    return True


def delete_skill(skill_path: str) -> bool:
    full = config.SKILL_DIR_ROOT / skill_path
    if not full.exists():
        return False
    shutil.rmtree(full, ignore_errors=True)
    owners = storage.load_owners()
    owners.pop(skill_path, None)
    storage.save_owners(owners)
    return True


def _sanitize_name(name: str) -> str:
    """把目录名限制到安全字符集，避免路径穿越。"""
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name).strip("._-")
    return name or "skill"


def _common_top(rel_paths: list[str]) -> str:
    """返回所有路径共享的顶层目录名（无共享则返回空串）。"""
    split = [p.split("/") for p in rel_paths if p]
    if not split or not split[0] or not split[0][0]:
        return ""
    first = split[0][0]
    return first if all(len(p) > 0 and p[0] == first for p in split) else ""


def _normalize_entries(entries: list[tuple[str, bytes]]) -> list[tuple[str, bytes]]:
    """归一化与过滤上传条目（丢弃目录项、__pycache__、点开头、路径穿越）。"""
    normalized: list[tuple[str, bytes]] = []
    for rel, data in entries:
        p = rel.replace("\\", "/").strip("/")
        if not p or p.endswith("/"):
            continue
        parts = [x for x in p.split("/") if x]
        if ".." in parts or any(x == "__pycache__" or x.startswith(".") for x in parts):
            continue
        normalized.append(("/".join(parts), data))
    return normalized


def _resolve_target(normalized: list[tuple[str, bytes]]) -> tuple[str, str]:
    """返回 (skill_name, skill_root_prefix)：目录名取自 SKILL.md 的 name 字段，
    无 SKILL.md 时回退公共顶层目录名；skill_root_prefix 用于剥离公共前缀。"""
    # 定位 SKILL.md（取层级最浅的那个），提取 name 与根前缀
    md_rels = sorted(
        (rel for rel, _ in normalized if rel.rsplit("/", 1)[-1].upper() == "SKILL.MD"),
        key=lambda r: r.count("/"),
    )
    skill_name = ""
    skill_root_prefix = ""
    if md_rels:
        md_rel = md_rels[0]
        skill_root_prefix = md_rel.rsplit("/", 1)[0]
        skill_root_prefix = skill_root_prefix + "/" if skill_root_prefix else ""
        md_data = next(data for rel, data in normalized if rel == md_rel)
        skill_name = _parse_frontmatter(md_data.decode("utf-8", errors="ignore")).get("name", "")
    skill_name = _sanitize_name(skill_name)

    # 无 SKILL.md 时回退公共顶层目录名（作为根前缀）
    if not skill_root_prefix:
        common = _common_top([rel for rel, _ in normalized])
        if common:
            skill_root_prefix = common + "/"
    return skill_name, skill_root_prefix


def _write_entries(target_full: Path, skill_root_prefix: str, normalized: list[tuple[str, bytes]]) -> None:
    """把归一化后的条目写入目标目录（剥离公共前缀，带路径穿越防护）。"""
    target_full.mkdir(parents=True, exist_ok=True)
    base = str(target_full.resolve())
    for rel, data in normalized:
        stripped = rel[len(skill_root_prefix):] if rel.startswith(skill_root_prefix) else rel
        stripped = stripped.strip("/")
        if not stripped:
            continue
        parts = [x for x in stripped.split("/") if x]
        if any(x == "__pycache__" or x.startswith(".") for x in parts):
            continue
        dest = target_full / "/".join(parts)
        if not str(dest.resolve()).startswith(base):
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)


def submit_upload(entries: list[tuple[str, bytes]], owner: str, confirm: bool = False) -> dict[str, Any]:
    """提交 skill 上传审核。

    上传内容先暂存到 review_stage/<id>，不直接写入正式目录：
      - 若 SKILL_DIR_ROOT 已存在同名目录（exists=True），审核通过后将整体覆盖；
      - 若不存在（exists=False），审核通过后才放入。
    存在同名 skill 且未二次确认（confirm=False）时，不暂存内容，
    提前返回 {"exists": True, "need_confirm": True, "skill_name"}，由前端二次确认后重传。
    返回 {"id", "skill_name", "exists"}。
    """
    normalized = _normalize_entries(entries)
    if not normalized:
        raise ValueError("上传内容为空")

    skill_name, skill_root_prefix = _resolve_target(normalized)
    exists = (config.SKILL_DIR_ROOT / skill_name).exists()

    # 存在同名 skill 时，需用户二次确认（确认后带 confirm=True 重新提交）
    if exists and not confirm:
        return {
            "skill_name": skill_name,
            "exists": True,
            "need_confirm": True,
        }

    # 已有同名待审核记录时，拒绝重复提交，避免覆盖语义混乱
    for rec in storage.load_reviews():
        if rec.get("skill_name") == skill_name:
            raise ValueError(f"「{skill_name}」已有上传正在审核中，请等待审核完成后再操作")

    review_id = storage.gen_id("rev")
    stage_dir = config.REVIEW_STAGE_DIR / review_id
    _write_entries(stage_dir, skill_root_prefix, normalized)

    reviews = storage.load_reviews()
    reviews.append(
        {
            "id": review_id,
            "skill_name": skill_name,
            "exists": exists,
            "owner": owner,
            "uploaded_at": storage.now_str(),
        }
    )
    storage.save_reviews(reviews)
    return {"id": review_id, "skill_name": skill_name, "exists": exists}


def list_pending_uploads(viewer: str, is_admin: bool) -> list[dict[str, Any]]:
    """待审核列表：管理员看全部，普通用户只看自己提交的。"""
    reviews = storage.load_reviews()
    result = []
    for rec in reviews:
        if not is_admin and rec.get("owner") != viewer:
            continue
        result.append(
            {
                "id": rec.get("id", ""),
                "skillName": rec.get("skill_name", ""),
                "exists": bool(rec.get("exists")),
                "owner": rec.get("owner", ""),
                "uploadedAt": rec.get("uploaded_at", ""),
            }
        )
    return result


def _find_review(review_id: str) -> dict[str, Any] | None:
    """按 id 查找待审核记录（不存在返回 None）。"""
    return next((r for r in storage.load_reviews() if r.get("id") == review_id), None)


def _can_view_review(rec: dict[str, Any] | None, user: str, is_admin: bool) -> bool:
    """审核记录可见性：记录须存在，且查看者为管理员或该记录的上传 owner。"""
    return rec is not None and (is_admin or rec.get("owner") == user)


def can_view_review(review_id: str, user: str, is_admin: bool) -> bool:
    """公开判断：审核记录是否存在且当前用户（owner/管理员）可访问。"""
    return _can_view_review(_find_review(review_id), user, is_admin)


def approve_upload(review_id: str) -> str:
    """审核通过：把暂存内容放入正式目录（同名先整体覆盖），并登记 owner。"""
    rec = _find_review(review_id)
    if rec is None:
        raise KeyError(review_id)
    skill_name = rec.get("skill_name", "")
    stage_dir = config.REVIEW_STAGE_DIR / review_id

    if stage_dir.is_dir():
        target_full = config.SKILL_DIR_ROOT / skill_name
        if target_full.exists():
            shutil.rmtree(target_full, ignore_errors=True)
        shutil.copytree(stage_dir, target_full)
        shutil.rmtree(stage_dir, ignore_errors=True)

    set_skill_owner(skill_name, rec.get("owner", ""))
    reviews = [r for r in storage.load_reviews() if r.get("id") != review_id]
    storage.save_reviews(reviews)
    add_notice(
        rec.get("owner", ""),
        "approved",
        skill_name,
        f"你上传的 Skill「{skill_name}」已通过管理员审核，现已生效可用。",
    )
    return skill_name


def reject_upload(review_id: str) -> None:
    """审核拒绝：丢弃暂存内容，移除审核记录，并通知上传者。"""
    rec = _find_review(review_id)
    if rec is None:
        raise KeyError(review_id)
    skill_name = rec.get("skill_name", "")
    shutil.rmtree(config.REVIEW_STAGE_DIR / review_id, ignore_errors=True)
    reviews = [r for r in storage.load_reviews() if r.get("id") != review_id]
    storage.save_reviews(reviews)
    add_notice(
        rec.get("owner", ""),
        "rejected",
        skill_name,
        f"你上传的 Skill「{skill_name}」未通过管理员审核，上传内容已被丢弃。",
    )


def withdraw_upload(review_id: str, user: str, is_admin: bool) -> bool:
    """审核通过前，上传者（或管理员）可撤销本次上传：丢弃暂存内容并移除记录。"""
    rec = _find_review(review_id)
    if not _can_view_review(rec, user, is_admin):
        return False
    assert rec is not None
    shutil.rmtree(config.REVIEW_STAGE_DIR / review_id, ignore_errors=True)
    reviews = [r for r in storage.load_reviews() if r.get("id") != review_id]
    storage.save_reviews(reviews)
    return True


def list_review_files(review_id: str, user: str, is_admin: bool) -> list[dict[str, Any]]:
    """待审核 skill 的暂存文件树（仅 owner 或管理员可见）。"""
    rec = _find_review(review_id)
    if not _can_view_review(rec, user, is_admin):
        return []
    stage_dir = config.REVIEW_STAGE_DIR / review_id
    result = []
    if not stage_dir.is_dir():
        return result
    for root, dirs, files in os.walk(stage_dir):
        dirs[:] = sorted(d for d in dirs if d != "__pycache__" and not d.startswith("."))
        for fn in sorted(files):
            if fn.startswith("."):
                continue
            p = Path(root) / fn
            rel = p.relative_to(stage_dir).as_posix()
            result.append({"path": rel, "name": fn, "size": p.stat().st_size})
    return result


def read_review_file(review_id: str, file_rel: str, user: str, is_admin: bool) -> str | None:
    """读取待审核 skill 的暂存文件内容（仅 owner 或管理员可见，带路径穿越防护）。"""
    rec = _find_review(review_id)
    if not _can_view_review(rec, user, is_admin):
        return None
    stage_dir = (config.REVIEW_STAGE_DIR / review_id).resolve()
    target = (stage_dir / file_rel).resolve()
    if not target.is_relative_to(stage_dir):
        return None
    if not target.is_file():
        return None
    try:
        return target.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None


def add_notice(user: str, kind: str, skill_name: str, message: str) -> dict[str, Any]:
    """给指定用户新增一条审核结果通知（same-user 并存保留）。"""
    notice = {
        "id": storage.gen_id("nt"),
        "user": user,
        "kind": kind,          # approved | rejected
        "skill_name": skill_name,
        "message": message,
        "created_at": storage.now_str(),
    }
    notices = storage.load_notices()
    notices.append(notice)
    storage.save_notices(notices)
    return notice


def list_notices(user: str) -> list[dict[str, Any]]:
    """返回某用户的全部未读审核通知（倒序：新的在前）。"""
    mine = [
        {
            "id": n.get("id", ""),
            "kind": n.get("kind", ""),
            "skillName": n.get("skill_name", ""),
            "message": n.get("message", ""),
            "createdAt": n.get("created_at", ""),
        }
        for n in storage.load_notices()
        if n.get("user") == user
    ]
    mine.sort(key=lambda n: n.get("createdAt", ""), reverse=True)
    return mine


def dismiss_notice(notice_id: str, user: str) -> bool:
    """用户取消（读过）某条通知：永久移除，之后不再发送。"""
    notices = storage.load_notices()
    new_notices = [
        n for n in notices if not (n.get("id") == notice_id and n.get("user") == user)
    ]
    if len(new_notices) == len(notices):
        return False
    storage.save_notices(new_notices)
    return True


def list_skill_files(skill_path: str) -> list[dict[str, Any]]:
    full = config.SKILL_DIR_ROOT / skill_path
    if not full.exists():
        return []
    result = []
    for root, dirs, files in os.walk(full):
        dirs[:] = sorted(d for d in dirs if d != "__pycache__" and not d.startswith("."))
        for fn in sorted(files):
            if fn.startswith("."):
                continue
            p = Path(root) / fn
            rel = p.relative_to(full).as_posix()
            result.append({"path": rel, "name": fn, "size": p.stat().st_size})
    return result


def read_skill_file(skill_path: str, file_rel: str) -> str | None:
    skill_root = (config.SKILL_DIR_ROOT / skill_path).resolve()
    target = (skill_root / file_rel).resolve()
    if not str(target).startswith(str(skill_root)):
        return None
    if not target.is_file():
        return None
    try:
        return target.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None


def list_skill_types() -> list[str]:
    root = config.SKILL_DIR_ROOT
    if not root.exists():
        return []
    return sorted(
        e.name
        for e in root.iterdir()
        if e.is_dir() and not e.name.startswith(".") and e.name != "__pycache__"
    )
