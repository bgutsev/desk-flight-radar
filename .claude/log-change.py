#!/usr/bin/env python3
"""PostToolUse hook: append a readable line to change-log.txt for each edit.

Reads the hook payload (JSON) from stdin and records when a file was changed,
which tool changed it, and the file path (relative to the repo root). The log
lives at the repository root and is git-tracked. Failures are swallowed so the
hook never blocks an edit.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import sys

# .claude/log-change.py -> repo root is two levels up, regardless of cwd.
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG_PATH = os.path.join(PROJECT_ROOT, "change-log.txt")


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

    timestamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"{timestamp} | {tool:<12} | {path}\n"
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(line)
    except OSError:
        pass


if __name__ == "__main__":
    main()
