# Documentation Workflow Skill

## Purpose

This skill ensures all code changes are properly documented in `.claude/CHANGELOG.md` immediately after implementation. Documentation should be treated as part of the development process, not an afterthought.

## Documentation File Organization

**CRITICAL**: Documentation files belong in specific locations:

### Root Directory (Project Root)

- `README.md` - Main project overview (user-facing)
- `TESTS_README.md` - Quick test guide (user-facing)
- `TESTING_GUIDE.md` - Detailed test scenarios (user-facing)
- `SIMULATOR_README.md` - Simulator usage (user-facing)
- `package.json`, `tsconfig.json` - Config files only

### `.claude/` Directory (Internal Documentation)

- **All technical documentation goes here!**
- `CHANGELOG.md` - All changes log
- `ARCHITECTURE.md` - System design
- `DEVELOPMENT_GUIDE.md` - Dev workflows
- `TEST_FAILURES_ANALYSIS.md` - Test debugging
- `TEST_SUITE_OVERVIEW.md` - Test architecture
- `TESTING_IMPLEMENTATION_SUMMARY.md` - Test summaries
- `*_IMPLEMENTATION_SUMMARY.md` - Feature summaries
- `*_TECHNICAL.md` - Technical deep dives

### `.claude/skills/` Directory

- Individual skill guides (SKILL.md files)
- One folder per skill domain

**Rule**: If it's technical documentation or analysis → `.claude/`
**Rule**: If it's user-facing quick reference → Root directory

## Critical Rule

**⚠️ ALWAYS UPDATE CHANGELOG IMMEDIATELY AFTER MAKING CHANGES ⚠️**

When you complete ANY of the following:

- Add new features or commands
- Fix bugs or issues
- Refactor code architecture
- Change command signatures or workflows
- Update API integrations
- Modify data patterns or Redis keys
- Remove deprecated features

You MUST update `.claude/CHANGELOG.md` in the SAME response/turn.

## Why This Matters

1. **Future Context**: Next time Claude (or another agent) works on this codebase, the changelog provides critical context
2. **User Understanding**: Users need to understand what changed and why
3. **Debugging**: When issues arise, the changelog helps identify when changes were made
4. **Team Coordination**: Other developers need to know about breaking changes
5. **Migration Planning**: Documentation of old → new patterns helps with transitions

## Documentation Workflow

### When Making Changes

```
✅ CORRECT WORKFLOW:
1. Make code changes
2. Test changes work
3. Update .claude/CHANGELOG.md
4. Respond to user confirming completion

❌ INCORRECT WORKFLOW:
1. Make code changes
2. Respond to user
3. Wait for user to ask "update the docs"
4. Then update changelog
```

### What to Document

Every changelog entry should include:

1. **Date Section**: Group by date (YYYY-MM-DD)
2. **Change Category**:
   - New Features
   - Breaking Changes
   - Bug Fixes
   - Performance Improvements
   - Refactoring
   - Documentation Updates
3. **Problem Statement**: What issue was being solved?
4. **Solution**: What was implemented?
5. **Examples**: Before/after code or command examples
6. **Files Modified**: List affected files with line numbers
7. **Migration Notes**: For breaking changes, explain migration path

### Changelog Structure

```markdown
# Changelog

## YYYY-MM-DD - [Category Title]

### [Subcategory]

#### Feature/Change Name

**Problem**: Clear description of what was wrong or needed

**Solution**: What was implemented

- Bullet points of key changes
- Technical details
- Design decisions

**Examples**:
```

[code/command examples]

```

**Files Modified**:
- `path/to/file.ts` - Lines XX-YY
- `another/file.ts` - New method `methodName()`

**Benefits**:
- User-facing benefits
- Technical improvements

**Migration Notes** (if breaking change):
- What users need to change
- Example migration paths
```

### Example Entry Template

```markdown
## 2026-01-30 - [Category]

### [Feature Group]

#### Specific Change Name

**Problem**: Describe the issue or requirement

**Solution**:

- What was built
- How it works
- Key implementation details

**Command Syntax**:
```

Old: /old-command format
New: /new-command format

```

**Files Modified**:
- `src/telegram/telegram.service.ts` - Added `newMethod()` (lines 100-150)

**Benefits**:
- Benefit 1
- Benefit 2

**Breaking Changes**:
- What breaks
- How to migrate
```

## Documentation Quality Standards

### ✅ Good Documentation

- **Specific**: Exact line numbers, method names, file paths
- **Complete**: Covers problem, solution, examples, files
- **Actionable**: Users know what to do next
- **Searchable**: Uses keywords that will help future searches
- **Timestamped**: Clear date sections

### ❌ Poor Documentation

- Vague: "Updated some files"
- Incomplete: No examples or file paths
- Unclear: Doesn't explain why change was made
- Unsearchable: Generic terms without context
- Undated: No clear timeline

## Automation Reminder

**To Future Claude**: When you make changes to this codebase:

1. ✏️ Write the code
2. 📝 Update `.claude/CHANGELOG.md` **in the same turn**
3. ✅ Confirm to user that both code AND docs are updated

Do NOT wait for the user to ask "update the docs". It should be automatic.

## Special Cases

### Multiple Related Changes

If making several related changes in one session:

- Create ONE changelog section for the feature group
- Include all subsections
- Cross-reference between changes

### Emergency Hotfixes

Even quick fixes need documentation:

- Mark as "Hotfix" in the title
- Brief problem/solution
- Which file was changed
- Consider adding to "Known Issues" if it's a workaround

### Refactoring

For code refactoring without user-facing changes:

- Document under "Technical Improvements"
- Explain why refactoring was done
- List performance improvements or code quality gains
- Note any internal API changes

## Integration with Other Skills

This skill works with:

- **command-handler**: Document new commands immediately
- **api-integration**: Document API changes and patterns
- **redis-data-patterns**: Document key pattern changes
- **debugging-guide**: Document fixes to known issues

## Checklist Before Completing Work

Before telling user "Done!" or "Completed!", verify:

- [ ] Code changes are complete and tested
- [ ] `.claude/CHANGELOG.md` has new entry with today's date
- [ ] Entry includes: problem, solution, examples, files modified
- [ ] Breaking changes are clearly marked
- [ ] Migration notes provided if needed
- [ ] Related skills documentation updated if needed

## User's Explicit Request

The user specifically asked:

> "why after you done change you not auto update on .claude pls add this rule to SKILL for you remember"

**Action Required**: From now on, ALWAYS update CHANGELOG.md immediately after making code changes. Do not wait to be asked.

## Summary

**Golden Rule**: Code + Documentation = Complete Work

Never consider a task "done" until the changelog is updated. Documentation is not optional—it's a core part of the development process.
