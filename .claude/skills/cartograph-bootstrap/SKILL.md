---
name: cartograph-bootstrap
description: Inject a token-bounded project orientation from Whisper knowledge, shared handoffs, and the Cartograph evidence graph. Use when starting or resuming substantial work, switching between Codex and Claude Code, or asking what is broken, risky, or structurally connected.
---

# Cartograph Bootstrap

Use this sequence once at task start. Do not dump whole repositories or full graphs.

1. State the active project alias and the concrete task in one sentence.
2. Call Whisper `efficiency_principles` for the task with a small output budget.
3. Call Whisper `inject_context` for the task and project alias. If the alias is not registered, continue with general principles and say so.
4. Call Cartograph `project_status` for the alias. If it is registered but unscanned or stale relative to the task, call `project_scan` once.
5. Call `graph_gaps` and `graph_plague`. Request only the relevant `graph_neighbors` neighborhood when a node or subsystem is known.
6. Summarize the injected context as: objective, current handoff, graph risks, relevant constraints, and next verified action.
7. During work, query Cartograph on demand. Do not reload the bootstrap pack every turn.
8. Before switching agents or ending a major phase, record one semantic Whisper checkpoint with decisions, next action, touched files, and verification evidence.

Safety and efficiency:

- Treat subject repositories as read-only unless the user explicitly asks to change the active subject.
- A green Cartograph node means a named check passed for its exact digest; it is not a general quality claim.
- Purple is a separate mechanical structural predicate, not a health status.
- Prefer graph summaries and one-to-three-hop neighborhoods over full exports.
- Never include source bodies, secrets, or absolute paths in shared checkpoints.
