---
name: update-docs
description: Update project documentation (MEMORY.md, CHANGELOG.md, and session changelog) after completing a task. Use this skill after finishing any implementation work to keep docs in sync.
user_invocable: true
---

# Update Docs Skill

This skill updates all project documentation after completing a task. Run it with `/update-docs` or invoke it automatically after finishing implementation work.

## What Gets Updated

### 1. MEMORY.md (Persistent AI Memory)
**Path**: `/Users/elvislee/.claude/projects/-Users-elvislee-Workspace-DTS-binance-tele-bot/memory/MEMORY.md`

Update these sections as needed:
- **Current Commands** — if new commands were added
- **Key Files** — if new important files were created
- **Module Architecture** — if new modules were added
- **Important Patterns** — if new conventions were established
- **Current Coin Settings** — if .env was changed
- **Money Flow Monitor** — if monitoring thresholds changed

**Rules:**
- Keep under 200 lines (truncated beyond that)
- Don't duplicate what's in CLAUDE.md
- Only add stable, confirmed patterns
- Remove outdated information

### 2. Project CHANGELOG.md
**Path**: `.claude/CHANGELOG.md`

Add a new entry at the TOP of the file (after `# Changelog` header) following this format:

```markdown
## YYYY-MM-DD (N) - Short Title

### Feature/Enhancement/Bug Fix: Description

What changed, why, and how. Include:
- What the feature does
- Key implementation details
- API endpoints or data sources used (if applicable)

### Files Modified
- `path/to/file.ts` — what changed
- `path/to/new-file.ts` — NEW (brief description)

---
```

**Numbering**: Use `(N)` suffix when multiple entries exist for the same date. Check existing entries.

**Categories to use:**
- `Feature:` — New functionality
- `Enhancement:` — Improvement to existing feature
- `Bug Fix:` — Fix for a bug
- `Refactor:` — Code reorganization without behavior change

### 3. Session Changelog (Memory)
**Path**: `/Users/elvislee/.claude/projects/-Users-elvislee-Workspace-DTS-binance-tele-bot/memory/changelog.md`

Add a brief session summary. This is a quick-reference for the AI to understand what happened in each session without reading the full CHANGELOG.

Format:
```markdown
## YYYY-MM-DD Session N — Short Title

### Features Added
1. **Feature name** — brief description

### Bug Fixes
- Description of fix

### Files Modified
- `file.ts` — what changed
```

## Step-by-Step Process

1. **Read current MEMORY.md** to understand what's already documented
2. **Review git diff** (`git diff HEAD~1` or `git status`) to see what changed
3. **Read the session conversation** to understand the full context of changes
4. **Update MEMORY.md** — add new commands, files, patterns, settings
5. **Add CHANGELOG.md entry** — detailed entry at top of file
6. **Update session changelog** — brief summary in memory/changelog.md
7. **Verify** — ensure no duplicates, outdated info removed

## Important Notes

- Always READ files before editing (don't guess current content)
- Keep MEMORY.md concise — it's loaded into every conversation
- CHANGELOG.md can be detailed — it's only read on demand
- Use the same date format: `YYYY-MM-DD`
- Check the `(N)` numbering — don't create a duplicate number for the same date
- If a feature was modified (not new), update the existing CHANGELOG entry instead of adding a new one
