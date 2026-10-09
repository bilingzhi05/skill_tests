# -*- coding: utf-8 -*-
"""
Skill 目录管理。

一个 skill = 含 SKILL.md（大小写不敏感）的目录；顶层子目录为「类型组」。
与前端 lib/skills.ts 行为一致：
  - 扫描、列表（owner 过滤）、详情
  - 上传 zip 替换（同类型同名先删后写）
  - 删除、设置 owner
  - 文件树、文件内容读取（含路径穿越防护）
"""
from __future__ import annotations

import io
import os
import shutil
import zipfile
from pathlib import Path
from typing import Any

from . import config, storage


def _extract_description(skill_dir: Path) -> str:
    """取 SKILL.md 前 3 行非标题文本作为描述。"""
    skill_md = _find_skill_md(skill_dir)
    if not skill_md:
        return ""
    try:
        lines: list[str] = []
        for raw in skill_md.read_text(encoding="utf-8", errors="ignore").splitlines():
            t = raw.strip()
            if t and not t.startswith("#") and not t.startswith("---"):
                lines.append(t)
            if len(lines) >= 3:
                break
        return " ".join(lines)[:200]
    except Exception:
        return ""


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
    skill_name = parts[-1]
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
            "skill_name": parts[-1],
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


def upload_skill(skill_type: str, skill_name: str, zip_bytes: bytes, owner: str) -> str:
    """解压上传的 zip 到 <type>/<name>/（已存在则整体替换），并登记 owner。"""
    target_rel = f"{skill_type}/{skill_name}"
    target_full = config.SKILL_DIR_ROOT / target_rel
    if target_full.exists():
        shutil.rmtree(target_full, ignore_errors=True)
    target_full.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for member in zf.infolist():
            name = member.filename.replace("\\", "/")
            if name.startswith("/") or ".." in name.split("/"):
                continue
            if "__pycache__" in name or name.startswith("."):
                continue
            parts = [p for p in name.split("/") if p]
            # 去掉与 skill 同名的顶层目录
            if parts and parts[0] == skill_name:
                parts = parts[1:]
            if not parts:
                continue
            rel = "/".join(parts)
            dest = (target_full / rel).resolve()
            if not str(dest).startswith(str(target_full.resolve())):
                continue
            if member.is_dir():
                dest.mkdir(parents=True, exist_ok=True)
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(member) as src, open(dest, "wb") as out:
                shutil.copyfileobj(src, out)

    set_skill_owner(target_rel, owner)
    return target_rel


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
