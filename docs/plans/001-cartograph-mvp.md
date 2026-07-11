# Cartograph MVP — Valtor Plan

## Goal

Ship a public, standalone Cartograph MVP that deterministically maps Whisper's
Python/FastMCP structure, exposes bounded graph queries over MCP, and renders an
inspectable evidence/status graph without leaking machine-specific data.

## Scope

In scope: project packet, Valtor ledger, Python/import/FastMCP extraction,
deterministic graph model/layout/export, SQLite registry/projection, evidence
statuses, unresolved gaps, cyclic-module plague, MCP tools, Whisper reference
graph, browser viewer, tests, documentation, and CI.

Out of scope: writing to subjects, runtime tracing, non-Python extractors,
symbol-complete call graphs, hosted service, authentication, and arbitrary AI
assignment of status.

## Stop condition

Stop when all acceptance tests pass, the Whisper reference export is path-free
and deterministic, MCP protocol smoke succeeds, browser QA verifies the viewer,
Valtor projections show the plan complete/repo healthy, and main is pushed to
`Tvaltorix/Cartograph`; or halt with a concrete blocker; or stop after 20 build
cycles.

## Verification

- `python -m pytest`
- repeat scan and byte-compare exports
- MCP initialize/list/call protocol smoke
- local HTTP viewer inspected at desktop and narrow width
- `node .agents/valtor/bin/index-rebuild.mjs`
- `git diff --check` and clean pushed branch

## State

Progress is recorded in `.agents/valtor/index/*.jsonl`; architecture and status
contracts live under `docs/`; generated databases and runtime artifacts remain
ignored.

## Work items

1. Foundation and contracts.
2. Deterministic graph model and safe Python/FastMCP extractor.
3. Evidence, gap, plague, and stable layout analysis.
4. SQLite registry/projection and CLI.
5. Bounded MCP interface.
6. Whisper reference graph and interactive viewer.
7. Verification, Valtor propagation, commit, and push.
