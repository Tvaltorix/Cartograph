# Cartograph

Cartograph is a living, evidence-bound map of codebase structure and health.
Each connected repository receives an independent graph namespace with stable
nodes, typed dependencies, explicit gaps, and digest-bound status.

Status is honest by construction:

- gray: unknown or stale;
- green: a named check passed against the current digest;
- yellow: warning or partial evidence;
- red: a check or required connection failed;
- purple halo: a deterministic structural-plague predicate fired.

Cartograph never edits subject repositories. Its SQLite store and graph exports
are rebuildable projections, not sources of truth.

## MVP workflow

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
.\.venv\Scripts\python.exe -m pytest
.\.venv\Scripts\cartograph.exe onboard C:\path\to\repo --shared
.\.venv\Scripts\cartograph.exe serve
```

The first reference subject is Whisper's two MCP servers. See
`docs/plans/001-cartograph-mvp.md`.

Open `http://127.0.0.1:8765/viewer/` after starting the server. Use **New
project** there or `cartograph onboard .` once, then `$start` in Codex or
`/start` in Claude Code. See `docs/CLIENT_SETUP.md`.

## Project structure

```text
src/cartograph/       graph model, extractors, store, CLI, MCP
viewer/               human-readable interactive graph
tests/                fixture-driven behavior and protocol tests
examples/             safe, path-free reference graph declarations/exports
.agents/valtor/       committed Valtor build ledger and gates
```
