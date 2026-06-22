# Log Intent Skill

## Trigger
Invoke this skill **proactively before starting any implementation task** — before the first Edit or Write of a bug fix, feature, or refactor. Do NOT wait for the user to ask. One call covers the whole batch of related edits; do not call it again for follow-up edits in the same task.

## Input
`$ARGUMENTS` — a single sentence (max 80 chars) describing what is being changed and **why**. Focus on intent, not mechanics. Examples:
- "widen ground band to 100m to handle barometric pressure variation"
- "add notification modal so AudioContext unlocks on explicit YES click"
- "reverse live/mock toggle direction: right=LIVE, left=MOCK"

## Instructions
1. Take `$ARGUMENTS` as the intent string.
2. Write it to `.claude/pending-comment.txt` using a Bash command so the PostToolUse hook does not consume it prematurely:
   ```
   python -c "open('.claude/pending-comment.txt','w',encoding='utf-8').write('INTENT')"
   ```
   Replace `INTENT` with the actual argument string (mind quotes — use the python -c approach to avoid shell escaping issues).
3. Do not announce the skill call in your response; proceed directly to the implementation.

## Permission
This write is pre-approved (never prompts) by the following allowlist entry in
`.claude/settings.local.json`:
```
Bash(python -c "open('.claude/pending-comment.txt','w',encoding='utf-8')*)
```
Keep the command in step 2 in this exact form — same quoting and argument order
— or it will no longer match the rule and will start prompting again.
