# Valtor `bin/` — Layer-A reference scripts (the portable safety layer)

These are the **hardened, deterministic** forms of Valtor's Layer-A logic (state-integrity + safety). They are
**universal**: every script imports `lib.mjs` and reads all repo-specifics from `../valtor.config.json`. Nothing
repo-specific is hardcoded — so this whole folder copies into any repo unchanged; only the config file differs.

- **Runtime:** Node (ESM `.mjs`), zero external deps — node builtins only. Cross-platform. Run from the repo root.
- **Source of truth:** the `*.jsonl` ledger files in `../index/` (append-only, committed, git-reviewable). Any
  SQLite index is a derived accelerator and is **not** required by these scripts.
- **Contract:** every script prints a single JSON object to stdout and uses exit code `0` = ok / pass, non-zero =
  fail / gate-block. The orchestrator reads the JSON; the exit code lets a gate block deterministically.
- **Until a script exists, the orchestrator runs the gate's intent by reasoning** (SCHEMA §4) — these scripts just
  harden that into something fast and repeatable.

`lib.mjs` exports: `loadConfig()`, `appendRow(table,row)`, `readRows(table)`, `git(args)`/`tryGit(args)`,
`matchesAny(path,globs)`, `parseDuration(s)`, `sha256(s)`, `uuid()`, `nowIso()`, `ok()`, `fail()`, `args()`,
`TABLES`, `HOME`/`INDEX`/`CONFIG_PATH`.

## Scripts (CLI contract)

| Script | Usage | Does | Layer-A item / gate |
|---|---|---|---|
| `init.mjs` | `node init.mjs` | Bootstrap: create `index/`, create empty `<table>.jsonl` for each table if missing, detect `config.deployGates` scripts (present/absent), report. Idempotent. | A7 / bootstrap |
| `lock.mjs` | `node lock.mjs <acquire\|heartbeat\|release\|status> [--state S --plan P]` | Manage `config.lock.path`. `acquire`: live non-stale lock → exit 1 with holder (HALT case 7); else write lock {instance_id,host,pid,started_at,current_state,plan_path,heartbeat_at}. `heartbeat`/`release`/`status`. Stale = older than `config.lock.staleAfter`. | A1 |
| `ledger.mjs` | `node ledger.mjs <append\|query\|tail\|init> <table> [json\|--filter k=v\|N]` | Append/read any ledger table (validates against `TABLES`). `query --filter`, `tail N`. | A4/A5 |
| `git-policy.mjs` | `node git-policy.mjs <check\|branch> [slug]` | `check`: if `config.gitPolicy.requireBranchOffDefault` and current branch == `defaultBranch` → exit 1 with remedy. `branch <slug>`: create+checkout `branchPrefix+slug` off the default branch. Refuses to suggest force-push. | A2 |
| `budget.mjs` | `node budget.mjs <inc\|check\|reset> <counter> [itemId]` | Track per-item counters (debug_iterations, retries, deploy_attempts, no_progress) in `budget.jsonl`; compare to `config.budget`; on exceed → exit 1 `{exceeded,counter,limit}` (HALT case 8). | A3 |
| `plan-drift.mjs` | `node plan-drift.mjs <plan-path>` | sha256 the plan + per-section hashes; diff vs latest `plans` row for that path → `{status:new\|unchanged\|drifted, added,removed,modified}`; append a `plans` row. | A6 |
| `scope-check.mjs` | `node scope-check.mjs <itemId> <file1,file2,...>` | Assert touched files ⊆ item.scope_files and ∉ `config.conflictZones.paths` (glob) and ∉ readonly_files. Escape → exit 1 `{escapes:[]}`. | A9 / G-scope |
| `deploy-health.mjs` | `node deploy-health.mjs [run-id]` | Classify the deploy: query CI (`config.deployGates.ciWorkflow`) via `gh run view` if available → `green\|red\|cancelled`; degrade to `unknown` with guidance if `gh` absent. | A8 / G5.5 |
| `index-rebuild.mjs` | `node index-rebuild.mjs` | Integrity check: ensure every table file exists + every line parses; report counts. Re-entry self-check: report open/in_progress items + the lowest incomplete state (resume hint). | A7 |

## Bootstrapping a new repo (the only per-repo work)

1. Copy `.claude/skills/valtor/`, `.claude/agents/valtor-*.md`, and `.agents/valtor/{SCHEMA.md,registry.json,bin/}`.
2. Rewrite `.agents/valtor/valtor.config.json` for the new repo (or let `/valtor` generate it from a repo scan).
3. Run `node .agents/valtor/bin/init.mjs` (or just `/valtor <plan>` — the orchestrator runs init on first use).
   It creates the empty ledger and detects the deploy gates. Turnkey — no logic is re-implemented.
