#!/usr/bin/env python3
"""PostToolUse hook: append a readable line to change-log.txt for each edit.

Reads the hook payload (JSON) from stdin and records when a file was changed,
which tool changed it, the file path (relative to repo root), and a short
comment describing *why* the change was made.

Comment resolution order:
1. .claude/pending-comment.txt — written by the /log-intent skill before the
   edit batch starts; consumed (deleted) on first use.
2. Diff heuristic — line delta + first named entity (def/class/fn/selector)
   extracted from the new content.

Failures are swallowed so the hook never blocks an edit.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys

# .claude/log-change.py -> repo root is two levels up, regardless of cwd.
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG_PATH = os.path.join(PROJECT_ROOT, "change-log.txt")
PENDING_PATH = os.path.join(PROJECT_ROOT, ".claude", "pending-comment.txt")


def _pending_comment() -> str:
    """Return and delete the pending intent comment, or empty string."""
    try:
        if os.path.exists(PENDING_PATH):
            with open(PENDING_PATH, encoding="utf-8") as fh:
                text = fh.read().strip()
            os.remove(PENDING_PATH)
            return text
    except OSError:
        pass
    return ""


def _heuristic_comment(tool: str, tool_input: dict) -> str:
    """Generate a basic comment from the diff when no intent was pre-logged."""
    if tool == "Write":
        content = tool_input.get("content") or ""
        n = sum(1 for ln in content.splitlines() if ln.strip())
        return f"new file ({n} lines)"

    old = tool_input.get("old_string") or ""
    new = tool_input.get("new_string") or ""
    delta = len(new.splitlines()) - len(old.splitlines())
    sign = f"+{delta}" if delta >= 0 else str(delta)

    # Try to name the first changed entity.
    for pattern, label in [
        (r"\bdef\s+(\w+)", "def"),
        (r"\bclass\s+(\w+)", "class"),
        (r"\bfunction\s+(\w+)", "fn"),
        (r"\bconst\s+(\w+)\s*=", "const"),
        (r"([.#][\w-]+)\s*\{", "selector"),
    ]:
        m = re.search(pattern, new)
        if m:
            return f"{sign} lines · {label} {m.group(1)}"

    return f"{sign} lines"


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return

    tool = payload.get("tool_name", "?")
    tool_input = payload.get("tool_input") or {}
    path = tool_input.get("file_path") or tool_input.get("notebook_path") or "?"
    try:
        path = os.path.relpath(path, PROJECT_ROOT)
    except ValueError:
        pass  # different drive on Windows — keep the absolute path

    comment = _pending_comment() or _heuristic_comment(tool, tool_input)
    timestamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"{timestamp} | {tool:<12} | {path:<40} | {comment}\n"
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(line)
    except OSError:
        pass


if __name__ == "__main__":
    main()
