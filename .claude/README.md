# Agent Skills for Binance-Telegram Trading Bot

This directory contains Agent Skills that help understand, debug, and extend the trading bot codebase.

## ⚠️ CRITICAL RULE FOR ALL SKILLS ⚠️

**ALWAYS update `.claude/CHANGELOG.md` immediately after making ANY code changes.**

See [documentation-workflow](skills/documentation-workflow/SKILL.md) for full details.

## What are Agent Skills?

Skills are modular, filesystem-based resources that provide domain-specific expertise. They help Claude (and developers) understand the codebase structure, debug issues, and implement new features by providing clear documentation and workflows.

## Available Skills

### 🏗️ [trading-bot-overview](skills/trading-bot-overview/SKILL.md)

**When to use**: Understanding project architecture, module relationships, or how components work together.

- Project structure and architecture
- Core modules (Telegram, Binance, OKX, Redis)
- Data flow and user journey
- Key files and their purposes

### 🐛 [debugging-guide](skills/debugging-guide/SKILL.md)

**When to use**: Investigating errors, unexpected behavior, or fixing bugs.

- Common issues and solutions
- Debugging techniques
- Error patterns
- Performance troubleshooting
- Quick debug checklist

### 🤖 [command-handler](skills/command-handler/SKILL.md)

**When to use**: Adding new Telegram commands or modifying existing ones.

- Adding new commands
- Command patterns (simple, with args, optional args)
- Input validation
- Response formatting
- Testing strategies

### 🔌 [api-integration](skills/api-integration/SKILL.md)

**When to use**: Adding support for new exchanges or updating API implementations.

- Adding new exchange modules
- Required service methods
- Exchange-specific considerations
- Error handling patterns
- Security best practices

### 💾 [redis-data-patterns](skills/redis-data-patterns/SKILL.md)

**When to use**: Working with user data, settings, or debugging storage issues.

- Key naming conventions
- Data structures
- Common storage patterns
- Querying and migrations
- Debugging Redis issues

### 📚 [documentation-workflow](skills/documentation-workflow/SKILL.md)

**When to use**: ALWAYS - after ANY code changes.

- **Critical Rule**: Always update CHANGELOG.md immediately after making changes
- Documentation quality standards
- Changelog entry structure
- What to document and how
- Integration with development workflow

## How Skills Work

Skills use a 3-level progressive disclosure model:

1. **Level 1: Metadata** (Always loaded)
   - Skill name and description
   - When to use this skill

2. **Level 2: Instructions** (Loaded when triggered)
   - Main SKILL.md content
   - Step-by-step guidance
   - Code examples

3. **Level 3: Resources** (Loaded as needed)
   - Additional reference files
   - Scripts and utilities
   - Templates

## Using Skills

### In Claude Code

Skills are automatically discovered when placed in `.claude/skills/` directory.

### In Code Reviews

Reference skills when reviewing PRs:

```
"This looks good! See the command-handler skill for best practices on input validation."
```

### In Documentation

Link to skills in README or docs:

```markdown
For adding new commands, see [command-handler skill](.claude/skills/command-handler/SKILL.md)
```

### For Onboarding

New team members can read skills to understand:

- How the project is structured
- Common patterns and practices
- How to add features
- How to debug issues

## Creating New Skills

To create a new skill:

1. Create directory: `.claude/skills/your-skill-name/`
2. Create `SKILL.md` with frontmatter:

```markdown
---
name: your-skill-name
description: What this skill does and when to use it
---

# Your Skill Title

## Section 1

Content...

## Section 2

Content...
```

3. Add additional resources as needed:
   - `REFERENCE.md` - Detailed reference
   - `EXAMPLES.md` - Code examples
   - `scripts/` - Utility scripts

## Maintenance

Skills should be updated when:

- Architecture changes
- New features are added
- Common issues are discovered
- Patterns evolve

## Quick Reference

| Need to...                   | Use this skill                                               |
| ---------------------------- | ------------------------------------------------------------ |
| Understand project structure | [trading-bot-overview](skills/trading-bot-overview/SKILL.md) |
| Fix a bug                    | [debugging-guide](skills/debugging-guide/SKILL.md)           |
| Add a new command            | [command-handler](skills/command-handler/SKILL.md)           |
| Add an exchange              | [api-integration](skills/api-integration/SKILL.md)           |
| Work with user data          | [redis-data-patterns](skills/redis-data-patterns/SKILL.md)   |
| View recent changes          | [CHANGELOG.md](CHANGELOG.md)                                 |

## Recent Updates

📋 See [CHANGELOG.md](CHANGELOG.md) for detailed change history and bug fixes.

## Contributing

When you solve a difficult problem or discover a new pattern:

1. Consider if it should be documented in a skill
2. Update the relevant skill or create a new one
3. Help future developers avoid the same challenges
