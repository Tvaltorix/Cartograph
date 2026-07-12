# Onboard once, start every chat

The normal workflow has two concepts.

## 1. Onboard a project once

For a project whose semantic documents and handoffs may be shared between
Codex and Claude Code:

```powershell
cartograph onboard . --shared
```

For a local graph with no Whisper project context:

```powershell
cartograph onboard .
```

For a personal project that Whisper must explicitly refuse:

```powershell
cartograph onboard . --private
```

The project name defaults to the folder name. Use `--name <alias>` only when a
different stable alias is useful. The same choices are available through **New
project** in the viewer.

| Mode | Cartograph graph | Whisper doctrine | Indexed handoffs/context |
|---|---:|---:|---:|
| shared | yes | yes | yes |
| map-only | yes | yes | no |
| private | yes | doctrine only | explicitly denied |

## 2. Start substantial work

In Codex:

```text
$start
```

In Claude Code:

```text
/start
```

`start` internally refreshes the graph, applies the stored privacy mode, loads
one bounded Whisper injection when allowed, checks gaps and structural plague,
and returns one compact re-entry brief. Users do not need to choose between
principles, protocol, handoff, pack, or injection commands.

## Another machine

Install Cartograph's stdio MCP server at user scope, then install the `start`
skill from `skills/start` for Codex and `.claude/skills/start` for Claude Code:

```powershell
codex mcp add cartograph -- C:\path\to\Cartograph\.venv\Scripts\cartograph-mcp.exe
claude mcp add --scope user cartograph -- C:\path\to\Cartograph\.venv\Scripts\cartograph-mcp.exe
```

The registry database and Whisper sharing policy remain machine-local. Graph
exports contain relative paths and evidence metadata, never registered roots or
source bodies.

## Advanced operations

`register`, `scan`, `project_status`, `inject_context`, and the other bounded
tools remain available for debugging and automation. They are implementation
primitives, not the normal user workflow.
