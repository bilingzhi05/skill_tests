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


def list_skills(viewer: str, is_admin: bool) -> list[dict[str, Any]]:
    skills = []
    for sp in scan_skill_dirs():
        info = _to_camel(sp)
        if not is_admin and info["owner"] != viewer:
            continue
        skills.append(info)
    return skills


def get_skill_detail(skill_path: str, viewer: str, is_admin: bool) -> dict[str, Any] | None:
    full = config.SKILL_DIR_ROOT / skill_path
    if not full.exists():
        return None
    info = _to_camel(skill_path)
    if not is_admin and info["owner"] != viewer:
        return None
    return info


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


def upload_skill(entries: list[tuple[str, bytes]], owner: str) -> str:
    """上传 skill 到 SKILL_DIR_ROOT/<name>，目录名取自 SKILL.md 的 name 字段。

    entries 为 [(相对路径, 数据), ...]，来自 zip 解压或文件夹上传。
    若有 SKILL.md 则用其 name 字段命名；否则回退公共顶层目录名。
    已存在同名目录时整体替换，并登记 owner。
    """
    # 1) 归一化与过滤（丢弃目录项、__pycache__、点开头、路径穿越）
    normalized: list[tuple[str, bytes]] = []
    for rel, data in entries:
        p = rel.replace("\\", "/").strip("/")
        if not p or p.endswith("/"):
            continue
        parts = [x for x in p.split("/") if x]
        if ".." in parts or any(x == "__pycache__" or x.startswith(".") for x in parts):
            continue
        normalized.append(("/".join(parts), data))
    if not normalized:
        raise ValueError("上传内容为空")

    # 2) 定位 SKILL.md（取层级最浅的那个），提取 name 与根前缀
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

    # 3) 无 SKILL.md 时回退公共顶层目录名（作为根前缀）
    if not skill_root_prefix:
        common = _common_top([rel for rel, _ in normalized])
        if common:
            skill_root_prefix = common + "/"

    # 4) 写入目标目录（同名先整体替换）
    target_full = config.SKILL_DIR_ROOT / skill_name
    if target_full.exists():
        shutil.rmtree(target_full, ignore_errors=True)
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

    set_skill_owner(skill_name, owner)
    return skill_name


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
