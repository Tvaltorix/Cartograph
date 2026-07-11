# Cartograph Project Packet

## Objective

Create a standalone, read-only observability graph that lets humans and agents
understand codebase dependencies, verified health, missing connections, and
mechanically detected structural disease across multiple projects.

## Users

- A developer reviewing one codebase visually.
- Claude Code or Codex querying bounded graph slices through MCP.
- Valtor planning waves from dependency and blast-radius evidence.

## Runtime

- Python 3.11+ backend, SQLite, FastMCP.
- Browser-native viewer with deterministic coordinates.
- Node 24 only for the portable Valtor tooling.

## Constraints and non-goals

- Subject repositories are read-only.
- Exports contain relative paths and structural metadata, never source contents
  or machine-specific roots.
- Gray/unknown is the default; status cannot imply evidence that does not exist.
- The MVP extracts Python modules/imports and FastMCP registrations.
- Runtime call tracing, every language, remote hosting, and automatic subject
  mutation are out of scope.

## Inputs and outputs

Input: an explicitly registered repository root plus optional declarations.

Output: deterministic graph JSON, a local SQLite projection, bounded MCP query
responses, and an interactive SVG viewer.

## Risks

- A graph hairball that is technically complete but unreadable.
- Stale results presented as current.
- Dynamic code producing false missing-edge claims.
- Absolute paths or subject identifiers leaking from a public export.
- Purple becoming an AI opinion rather than a reproducible predicate.

## Verification

- Unit fixtures for imports, gaps, cycles, statuses, privacy, and determinism.
- Same input produces byte-identical JSON and stable coordinates.
- MCP initialize/list/call smoke test.
- Browser review of every status, gap, selection, filter, and responsive state.

## Decisions

- Separate repository and database from Whisper.
- One graph namespace per project; cross-project connections use boundary stubs.
- Operational color and structural-plague overlay are independent.
- Module-level overview first; symbols are progressive disclosure.
