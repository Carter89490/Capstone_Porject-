# Claude Code layout

| Location | What goes here | Loaded |
|---|---|---|
| `/CLAUDE.md` | Project overview, commands, conventions | Every session |
| `rules/*.md` | Topic-specific instructions (e.g. `testing.md`, `style.md`); add `paths:` frontmatter to scope a rule to certain files | Every session (or when matching files are touched) |
| `agents/*.md` | Subagents: frontmatter `name`, `description`, optional `tools`/`model`, then the system prompt | When delegated to |
| `commands/*.md` | Slash commands: `review.md` → `/review`; use `$ARGUMENTS` for input | When you type the command |
| `skills/<name>/SKILL.md` | Skills: one folder each, frontmatter `name` + `description`, plus any supporting files | When relevant or invoked |
| `settings.json` | Shared permissions, hooks, env vars | Every session |

Personal, uncommitted variants: `/CLAUDE.local.md` and `.claude/settings.local.json`.
The `.gitkeep` files only keep empty folders in git — delete them once a folder has real files.
