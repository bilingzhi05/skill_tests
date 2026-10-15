# -*- coding: utf-8 -*-
"""临时脚本：验证 server/skills_mgr.py 中 _parse_frontmatter 的解析结果。

用法：
    python check_frontmatter.py <SKILL.md 路径>
"""
from __future__ import annotations

import sys
from pathlib import Path

from server.skills_mgr import _parse_frontmatter


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("用法: python check_frontmatter.py <SKILL.md 路径>")
        return 2
    path = Path(argv[1])
    text = path.read_text(encoding="utf-8", errors="ignore")
    result = _parse_frontmatter(text)

    print("=" * 70)
    print(f"文件       : {path}")
    print(f"解析结果   : {result!r}")
    print("-" * 70)
    name = result.get("name", "")
    desc = result.get("description", "")
    print(f"name        ({len(name)} 字): {name}")
    print(f"description ({len(desc)} 字): {desc}")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
