# Valtor — an autonomous team-of-roles build engine (drop-in "chip")

Drop a plan in, and a **team of role sub-agents coordinated by a tech-lead orchestrator** works it like a software
team — **on loop, until the plan is complete and the repo is healthy.** It first **reads the plan as a structured
prompt** (G0 plan-refine: surfaces the *why*, infers machine-checkable "Done means" criteria, builds verification in
so you're never the QA), enforces the host repo's locked architecture + security, keeps a durable ledger of
done/remaining/blocked, debugs its own failures, sweeps for stale/orphaned work, reports its own readiness,
anticipates the questions a demo will get, and **confers with you in prose** at the real decision points. Three
optional books extend it — a plan-level **Council** of standards advisors, **artifact plans** + a guardrail cascade +
no-stale-data propagation, and a **game-dev fleet** with an asset-delivery contract. Re-entrant across sessions, safe
to leave running, **portable across repos** — one config file is the only seam.

## Activate it (in this repo)

- **Address it:** "Hello Valtor" / "Valtor, let's get back to work" → wakes, runs a resume self-check, reports status.
- **Give it a plan:** `/valtor <path-to-plan>` (or "Valtor, build out `<plan>`"). Merely *discussing* Valtor does not trigger it.

## What's in the chip

| Path | What |
|---|---|
| `.claude/skills/valtor/SKILL.md` | The orchestrator brain (the `/valtor` command + direct-address activation). |
| `.claude/agents/valtor-*.md` | The 9 role sub-agents (pm, dev, reviewer, debugger, data, security, qa, devops, designer) — scoped tools, model tiers, hand-back contracts. |
| `.agents/valtor/SCHEMA.md` | The canonical contract: roles, the ACQUIRE-LOCK + S0–S11 + S-DEBUG/S-RETRO state machine (incl. **G0 plan-refine** at ingest and the config-gated **S1.5 Council**), the LoopItem + ledger tables, the gates, the readiness model, the Anticipated-Q&A. |
| `.agents/valtor/COUNCIL.md` | **Book I** — plan-level advisory seats (ISSO, DBRE, Legal, Requirements, UX, Dev, Mobile) at S1.5 + S-RETRO. Read-only; own no gates. Dormant behind `config.council`. |
| `.agents/valtor/EXTENSIONS.md` | **Book II** — artifact plans (data-island boards ingestible as plans), the FIX→SWEEP→RATCHET guardrail cascade, lockstep propagation (no stale data). Behind `config.artifacts` + `propagation.map.json`. |
| `.agents/valtor/GAMEDEV.md` | **Book III** — game-dev dispatch fleet (gamedir/gamedesign/art/unreal/unity/gameplay), the asset-delivery contract, and **G-import** in-engine validation. Dormant behind `config.game`. |
| `.agents/valtor/SWEEPS.md` | **Book IV** — two invocable operations: **Reconcile Sweep** (doc+data currency) + **Verification Sweep** (functional correctness → READY/NOTES/HOLD verdict). Compose existing gates; `/reconcile-sweep` + `/verification-sweep`; seam `config.sweeps`. |
| `.agents/valtor/VALTOR-MASTER.md` | Generated, stamped compilation of SCHEMA + the four books (a projection — edit the sources, regenerate this; never hand-edit). |
| `.agents/valtor/propagation.map.json` | Book II §3.4 chip default: which surfaces each T0 fact class feeds (drives the dirty-set flush + G7 fingerprint audit). |
| `.agents/valtor/registry.json` | Additive gates / roles / detectors / projections. Grow Valtor by adding an entry here — never by editing the state machine. Book entries (Council seats, game fleet, staleness/asset detectors, artifact boards) ship **dormant** behind their config seams. |
| `.agents/valtor/bin/` | 30 universal Node scripts (`lib.mjs` + Layer-A safety + detectors + gate runners + projection renderers + `package.mjs`). Zero deps; read everything from the config. |
| `.agents/valtor/valtor.config.json` | **The only per-repo seam.** Region locks, language policy, conflict zones, extractors, budgets, stakeholders. |
| `.agents/valtor/index/` | The ledger (`*.jsonl` committed = source of truth; `*.sqlite`/lock/run-journal git-ignored, rebuildable). |
| `.agents/valtor/ROADMAP.md` | The build register (Layers A/B/C) + what's contract-complete vs implemented. |
| `.agents/valtor/bin/README.md` | The CLI contract for every `bin/` script. |

**A gate runs on orchestrator reasoning until its `bin/` script exists** (a gate is never skipped) — so judgment gates
(code-review, debug, arch-security, ready, verify, propagate, anticipated-Q&A) run on reasoning by design; the
deterministic ones (lock, budget, scope, detectors, renderers, db/migration/contract checks) are hardened scripts.

---

## Transfer it to another project (the chip)

**Nothing repo-specific lives in the universal files** — only `valtor.config.json` changes per repo. Two ways:

### A) Automated eject (recommended)
```
node .agents/valtor/bin/package.mjs --out ../my-other-repo-valtor-drop
```
This copies the portable set into `--out` and generates a generic `valtor.config.template.json` (in place of this
repo's config). Then, in the destination repo:
1. Copy the ejected `.claude/` and `.agents/` trees into the repo root.
2. `mv .agents/valtor/valtor.config.template.json .agents/valtor/valtor.config.json` and fill it in (see below).
3. Paste the `.agents/valtor/.valtor-gitignore-note.txt` stanza into the repo's `.gitignore`, then delete the note.
4. `node .agents/valtor/bin/init.mjs` (or just say "Hello Valtor") — creates the empty ledger + detects deploy gates.

### B) Manual copy
Copy these, then do steps 2–4 above:
```
.claude/skills/valtor/
.claude/agents/valtor-*.md
.claude/agents/council-*.md          # only if you'll enable the Council (Book I)
.agents/valtor/SCHEMA.md
.agents/valtor/COUNCIL.md             # Book I
.agents/valtor/EXTENSIONS.md          # Book II
.agents/valtor/GAMEDEV.md             # Book III
.agents/valtor/SWEEPS.md              # Book IV (+ .claude/commands/{reconcile,verification}-sweep.md)
.agents/valtor/propagation.map.json   # Book II §3.4 chip default
.agents/valtor/registry.json
.agents/valtor/ROADMAP.md
.agents/valtor/README.md
.agents/valtor/bin/
```
(`VALTOR-MASTER.md` is a generated projection — regenerate it in the destination rather than copying, or copy it and
never hand-edit.) The book entries in `registry.json` ship **dormant**; flip `config.council` / `config.artifacts` /
`config.game` on only where a repo needs them. `config.planRefine` is **on by default** and needs no scripts.
**Do NOT copy:** `valtor.config.json` (this repo's seam — start from the template), `.agents/valtor/index/*` (ledger
data — created fresh by `init`).

### Filling in `valtor.config.json` for the new repo
The template marks every per-repo field with a sibling `_doc`. The blocks to set:
- `masterContext` → the repo's primary context doc.
- `archGates` → region/language/scope/key/identity invariants (or flip them off for a non-regulated repo).
- `conflictZones.paths` → files only the orchestrator may edit (IaC, CI workflows, lockfiles, the master doc).
- `extractors` → the route / UI-call-site / event-lockstep / migration globs+patterns for the repo's frameworks.
- `deployGates` → the repo's smoke-test / authz-sweep / CI workflow (Valtor auto-detects + scaffolds if absent).
- `stakeholders` → the audiences whose questions the Anticipated-Q&A predicts.
- `domainMap`, `dataSafety.realDataTables`, `nfrBudgets`, `demoPath` → as applicable.

### Optional: auto-resume on session start (a hook)
Valtor activates fine by direct address without this. If you want it to *announce* in-flight work when a session
starts, add a `SessionStart` hook that runs `node .agents/valtor/bin/index-rebuild.mjs`. Easiest + schema-safe way:
ask Claude Code to "add a SessionStart hook running `node .agents/valtor/bin/index-rebuild.mjs`" (the `/update-config`
skill wires it correctly). Not auto-added here to avoid shipping a hand-written hook that might not match your version.

---

## Run it

`node .agents/valtor/bin/init.mjs` once, then `/valtor <plan>`. Useful direct script calls (all print JSON, read the
config): `node .agents/valtor/bin/render-board.mjs` (exec board), `render-system-map.mjs` (connection map),
`render-readiness.mjs`, `render-blockers.mjs`, and the `detect-*.mjs` orphan/stale detectors. See `bin/README.md`.
