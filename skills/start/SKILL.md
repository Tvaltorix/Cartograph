---
name: start
description: Start or resume substantial project work with one token-bounded command that onboards missing projects, loads the correct Whisper handoff under the project's privacy policy, refreshes the Cartograph graph, and reports the next verified action. Use when the user invokes $start, begins a new coding chat, switches between Codex and Claude Code, resumes a project, or asks to load project context.
---

# Start

Hide the underlying context commands. The user should need only `$start` in Codex or `/start` in Claude Code.

1. Identify the current repository root, its stable alias, and the concrete task.
2. Call Cartograph `project_status`. If the project is missing, ask one question only: `shared`, `map-only`, or `private`. Then call `project_onboard` with the current root. Do not ask again after the choice is stored.
3. Call Cartograph `project_scan` once so graph evidence matches the current source digest.
4. Apply the stored privacy mode:
   - `shared`: call Whisper `inject_context` once with the task, alias, and project root. Do not separately call principles, packs, handoff, or protocol commands; injection already combines them.
   - `map-only`: call Whisper `efficiency_principles` with a small budget. Do not request project files, indexed context, or checkpoints.
   - `private`: call only Whisper `efficiency_principles`. Never call project injection, search, read, handoff, or checkpoint tools.
5. Call Cartograph `graph_gaps` and `graph_plague`. Call `graph_neighbors` only when the task names a component.
6. Return one compact start brief: objective, latest handoff if allowed, graph risks, constraints, and next verified action.
7. Continue the task without reloading the start packet every turn.
8. At a real phase boundary, record one Whisper checkpoint only for `shared` projects.

Treat green as a named digest-bound check, not a general quality claim. Keep source repositories unchanged during onboarding.
