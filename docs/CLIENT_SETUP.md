# Client setup and task injection

Cartograph is useful outside its own repository because the MCP server keeps a
local project registry. The registry stores machine paths in the user's ignored
SQLite database; MCP responses and committed graph exports omit them.

## Codex

Install the server for all Codex repositories:

```powershell
codex mcp add cartograph -- C:\path\to\Cartograph\.venv\Scripts\cartograph-mcp.exe
```

Start a new Codex session after adding it. The portable bootstrap skill is
`skills/cartograph-bootstrap/SKILL.md`; install it in the user's skills folder
and invoke `$cartograph-bootstrap` at the beginning of substantial work.

## Claude Code

Install the same stdio server at user scope:

```powershell
claude mcp add --scope user cartograph -- C:\path\to\Cartograph\.venv\Scripts\cartograph-mcp.exe
```

Install `.claude/skills/cartograph-bootstrap/SKILL.md` in the user skills
folder. Invoke `/cartograph-bootstrap` when beginning or resuming work.

## First registration

Each project is registered once, then rescanned explicitly when its code
changes:

```powershell
cartograph register --name MyProject --path C:\path\to\MyProject
cartograph scan --name MyProject
```

The bootstrap combines two layers instead of replacing Whisper:

1. Whisper supplies curated operating principles, semantic handoffs, and
   cross-agent continuity.
2. Cartograph supplies current, digest-bound code structure, gaps, dependencies,
   and mechanical structural warnings.

Git history remains evidence of changes, not the context database. A new chat
does not inherit another chat's hidden transcript; it reconstructs a bounded
working state from Whisper plus Cartograph.

## Refresh model

The MVP uses explicit scans. This avoids a permanent watcher and prevents
unreviewed filesystem activity. A commit hook or Valtor phase gate can call
`cartograph scan --name <alias>` after tests. Runtime tracing and webhook-driven
refresh are future adapters and must preserve digest binding and read-only
subject access.
