#!/usr/bin/env python3
"""PostToolUse hook: append a line to change-log.txt for each edit.

Reads the hook payload (JSON) from stdin. Only logs if .claude/pending-comment.txt
exists (written by /log-intent). Each file is logged at most once per intent —
tracked via .claude/logged-paths.txt (sidecar). When /log-intent writes a new
intent the sidecar resets automatically, so the next task starts clean.

Failures are swallowed so the hook never blocks an edit.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import sys

# .claude/log-change.py -> repo root is two levels up, regardless of cwd.
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG_PATH = os.path.join(PROJECT_ROOT, "change-log.txt")
PENDING_PATH = os.path.join(PROJECT_ROOT, ".claude", "pending-comment.txt")
SIDECAR_PATH = os.path.join(PROJECT_ROOT, ".claude", "logged-paths.txt")


def _pending_comment() -> str:
    """Return the current intent comment, or empty string if none."""
    try:
        if os.path.exists(PENDING_PATH):
            with open(PENDING_PATH, encoding="utf-8") as fh:
                return fh.read().strip()
    except OSError:
        pass
    return ""


def _already_logged(path: str, comment: str) -> bool:
    """True if this file was already logged under the current intent.

    The sidecar stores the intent on line 1 and logged paths on subsequent
    lines. If the stored intent differs from the current one, the sidecar is
    stale (new task started) and is treated as empty.
    """
    try:
        if not os.path.exists(SIDECAR_PATH):
            return False
        with open(SIDECAR_PATH, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
        if not lines or lines[0] != comment:
            return False  # different intent — sidecar belongs to previous task
        return path in lines[1:]
    except OSError:
        return False


def _mark_logged(path: str, comment: str) -> None:
    """Record that this file has been logged under the current intent."""
    try:
        # If sidecar is stale (different intent), overwrite it fresh.
        existing_comment = ""
        existing_paths: list[str] = []
        if os.path.exists(SIDECAR_PATH):
            with open(SIDECAR_PATH, encoding="utf-8") as fh:
                lines = fh.read().splitlines()
            if lines and lines[0] == comment:
                existing_comment = lines[0]
                existing_paths = lines[1:]

        if existing_comment != comment:
            existing_paths = []

        existing_paths.append(path)
        with open(SIDECAR_PATH, "w", encoding="utf-8") as fh:
            fh.write(comment + "\n" + "\n".join(existing_paths) + "\n")
    except OSError:
        pass


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

    if os.path.abspath(path) == os.path.abspath(LOG_PATH):
        return

    comment = _pending_comment()
    if not comment:
        return  # no intent registered — skip

    if _already_logged(path, comment):
        return  # already logged this file for this task

    _mark_logged(path, comment)

    timestamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"{timestamp} | {tool:<12} | {path:<40} | {comment}\n"
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(line)
    except OSError:
        pass


if __name__ == "__main__":
    main()
