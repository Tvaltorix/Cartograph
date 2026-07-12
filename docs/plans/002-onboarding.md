# Cartograph Onboarding and Start

## Goal

Reduce the user workflow to two concepts:

1. `cartograph onboard .` once per project.
2. `$start` in Codex or `/start` in Claude Code at the beginning of substantial work.

## Privacy modes

- `shared`: map code locally and enroll semantic documents in Whisper for indexed handoffs.
- `map-only`: map code locally; do not add the project to Whisper.
- `private`: map code locally and add the root and alias to Whisper's deny policy.

No mode exports source bodies or absolute paths through Cartograph. Shared mode
updates only Whisper's gitignored machine-local source registry.

## Scope

- One onboarding service reused by CLI, MCP, and the loopback viewer API.
- Project alias, privacy mode, scan, and graph persistence in one operation.
- Viewer project switcher, refresh action, and New Project dialog.
- A compact `start` skill that hides individual Whisper/Cartograph tool calls.
- Compatibility documentation for the older commands without requiring them.

## Verification

- Fixture tests prove shared enrollment, map-only non-enrollment, and private denial.
- CLI test proves path/name inference and a sanitized result.
- MCP protocol test lists and calls `project_onboard`.
- Loopback API tests reject non-JSON writes and never return registered roots.
- Browser test onboards a fixture, switches projects, refreshes, and renders its graph.
- Existing extraction, privacy, deterministic export, and smoke tests remain green.

## Stop condition

Stop when the two-command mental model works from CLI and both agent clients,
the privacy choice is explicit, the viewer can onboard and switch projects, CI
passes, and only Cartograph has commits or pushes.
