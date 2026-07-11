# Valtor — Build Roadmap & Gap Register

> The overall plan: every gap (the user's named asks + the ones surfaced in design + the adversarial sweep),
> prioritized and sequenced into three build layers. The contract design for all of these already lives in
> `SCHEMA.md` / `registry.json` / `valtor.config.json`. This file tracks **what's contract-complete vs.
> implementation-pending**, so Valtor can build itself out the same way it builds anything else.
>
> **Build order principle:** state-integrity → failure-handling → reporting. Reporting reads ledger surfaces
> the earlier layers create; failure-handling without a budget guard is more dangerous than none. Each layer
> leaves Valtor fully runnable. All additions are registry/config/SCHEMA entries (the state machine is never
> edited); gates run on orchestrator reasoning until a `bin/` script hardens them.

Legend for "Maps": **[a]** debugging · **[b]** readiness+blockers · **[c]** exec-board · **[d]** connection-map · **[new]** sweep-surfaced.

---

## Layer A — STATE INTEGRITY + SAFETY  *(build next; the loop is unsafe to run unattended without these)*

Ships as pure orchestrator logic + config + SCHEMA — **no new sub-agent files, no `bin/` scripts required.**

| # | Gap | Closes with | Maps |
|---|---|---|---|
| A1 | No cross-session lock (two loops corrupt index; `cancel-in-progress` kills the other's CI) | `config.lock` lockfile + heartbeat; pre-S0 ACQUIRE-LOCK; HALT case 7; CI run-id match | new |
| A2 | Commits/self-edits go straight to `main`, unrewindable (force-push denied) | `config.gitPolicy` branch-off-default `loop/<slug>`; self-edits isolated; merge at S11 | new |
| A3 | "Until done" can spin forever / oscillate | `config.budget` (retries, debug-iters, deploy-attempts, no-progress, wall-clock); HALT case 8 | a/b |
| A4 | Gate outcomes / transitions / decisions / plan fingerprints not persisted | ledger tables `gate_results`, `status_transitions`, `decisions`, `plans`, `failures`, `run_journal` | b/c/new |
| A5 | Answered questions re-asked on re-entry | `decisions` ledger consulted at S2; standing/arch answers graduate to ADR+memory | new |
| A6 | Plan-drift undetected | hash plan at S0; `plan-drift` detector re-decomposes the delta | new |
| A7 | Index declared rebuildable but no path | `index-rebuild` projection + re-entry self-check; committed `*.jsonl` exports | new |
| A8 | S8 has no red/cancelled-deploy path; broken main, no remediation | G5.5 green/red/cancelled; `git revert` on branch (never reset); freeze-wave-on-red | b |
| A9 | Worker scope-escape asserted but never checked | `G-scope` at RECONCILE-OUT | new |

## Layer B — FAILURE + CORRECTNESS SPINE  *(the loop survives failure and gates correctness; 2 new sub-agents)*

| # | Gap | Closes with | Maps |
|---|---|---|---|
| B1 | No DEBUG state — only "re-dispatch or escalate" | **S-DEBUG** sub-loop + **`valtor-debugger`** role; failure catalog consulted first | a |
| B2 | Triage folded into the author (same blind spot) | debugger reads broad / writes nothing; hands a fix-spec; conflict-zone cause → orchestrator | a |
| B3 | Failure catalog is write-only | DEBUG step-0 greps it + the `failures` table; orchestrator appends at escalation | a |
| B4 | No flaky/transient quarantine | DEBUG reproduces N×; `transientSignatures` auto-retry; `flaky-criterion` detector | b |
| B5 | Partial-wave failure blast radius undefined | integrate green siblings; freeze only the failed item's `depends_on` subtree | b |
| B6 | No independent reviewer (self-review shipped the multi-bug PR) | **`valtor-reviewer`** + **G4b** at INTEGRATE, fresh instance, wired to `/code-review` | new |
| B7 | No Definition-of-Ready (items dispatch under-specified) | **G2b** at CLEAR; designer activates at S3 for UI | b |
| B8 | Inter-item contract drift caught only after both commit | pin `contracts` at S4; **G4c** lockstep at INTEGRATE | d |
| B9 | Migration safety beyond constraint-presence | **G3b** (down-pair, backfill, destructive-on-real-data, migrate-before-deploy) | new |
| B10 | Wave order ignores priority | LoopItem severity/priority/size/risk; S4 sorts within level by (severity,priority) | new |

## Layer C — REPORTING + MAP SURFACES  *(the named asks b/c/d; reads Layer-A's ledger)*

| # | Gap | Closes with | Maps |
|---|---|---|---|
| C1 | No bucketing for "% by plan/phase/domain" | LoopItem `plan_id`/`phase`/`domain`; `config.domainMap` | c |
| C2 | No readiness model | SCHEMA §10: 6 dimensions, overall = `min()`; `readiness` projection | b |
| C3 | No executive board | `board` projection: completion table, gauges, Mermaid, burn-down, top blockers | c |
| C4 | No blockers register | `blockers` projection from 5 computable sources, computed severity + age | b |
| C5 | Deferred vs out-of-scope collapse → denominator lies | LoopItem `out_of_scope` (excluded+listed); deferred stays as its own column | c |
| C6 | No system/connection map (the index models a graph but discards it) | `system-map` projection: Mermaid + `graph.jsonl`; edges = UNION of detector extractors | d |
| C7 | No blast-radius query before dispatch | `blast-radius(item)` over `graph.jsonl` at S4; `shared-node-collision` detector | d |
| C8 | Map currency / provenance | regen at S9+S10; `governed_by`/`implemented_by` edges; doc-stale ties via `last_seen_commit` | d |
| C9 | No retro/learning feeding the registry | **S-RETRO** + `retro` projection (proposes registry additions + bin/ codification) | new |
| C10 | No E2E / NFR / observability gates | `G-E2E`, `G-NFR`, `G-Observability` (active:false, activateWhen) | new |
| C11 | DEMO-READY can't know the demo path | LoopItem `demo_path`/`demo_tag` from `config.demoPath` | c |
| C12 | Map degraded-mode for repos missing some seams | `config.map.requireSeams/optionalSeams`; min viable = routes+UI+migrations | d |
| C13 | No stakeholder/demo Q&A; no learning of what matters to the user | `anticipated-qa` projection + `concerns` learning ledger + `config.stakeholders` (SCHEMA §11); auto at phase-completion + on-demand; stakeholder + skeptic lenses | new + c |

## Layer D — COMPANION BOOKS  *(the merge; each ships dormant behind a config seam so the core stays lean + portable)*

Additive registry/config/SCHEMA entries only — the state machine gains G0 (a gate within INGEST) and the config-gated
S1.5 sub-state, both following the S-ASK "return to raising state" pattern. Nothing here is required to run the core loop.

| # | Gap | Closes with | Book |
|---|---|---|---|
| D0 | Plans arrive as rough asks; the *why* + machine-checkable criteria are discovered late (at G2b) or never | **G0 plan-refine** at S0 (SCHEMA §2.1): read the plan as a structured prompt; infer why + "Done means" criteria + built-in verification; batch asks; genuine ambiguity → one confer before decompose. `config.planRefine` (**on by default**; invokes the `refine-prompt` skill when present, else reasons inline) | (core) |
| D1 | No plan-level standards review before decompose; Legal/compliance had zero coverage | **S1.5 Council** + 7 `council-*` seats (ISSO/DBRE/Legal/Req/UX/Dev/Mobile), GC-council gate, `council.jsonl`, activation matrix | I |
| D2 | Boards were write-only projections, not ingestible; humans couldn't round-trip edits | **Artifact plans** — data-island contract; INGEST `.html` at S0 (hash the island only); PROPAGATE regenerates boards from the ledger; Export-intents micro-plans | II·1 |
| D3 | A fix closed on the instance; siblings found only by luck; guardrail could be installed red | **Guardrail cascade** FIX→SWEEP→RATCHET: S-DEBUG emits a class *signature*; sweep is the signature's first run; ratchet installs it green; G-guardrail verifies the full chain | II·2 |
| D4 | "Docs update in lockstep" was an intention; counters/decisions could disagree across surfaces | **Lockstep propagation**: truth hierarchy T0→T3, provenance stamps + `{{cite:...}}` tokens, `propagation.map.json` dirty-set flush, G7 fingerprint audit blocks done | II·3 |
| D5 | No domain fleet for game repos; assets had no "diff" and no import validation | **Game-dev fleet** (gamedir/gamedesign/art/unreal/unity/gameplay); asset-delivery contract; **G-import** (in-engine validation, importer≠exporter); content-aware blast radius; asset-orphan detectors | III |

---

## Status (2026-07-09)

- **Book IV — SWEEPS registered (registry v0.4.0, committed 2026-07-08):** `SWEEPS.md` added as the fourth
  canonical book — the Reconcile + Verification sweeps as invocable operations composing the existing gates;
  seam `config.sweeps`; portable `/reconcile-sweep` + `/verification-sweep` commands; cross-linked from
  SCHEMA/README/the master this pass.
- **Guardrail hardened (2026-07-09):** fixed a latent `check-project-agnostic.mjs` bug — exact-file scan
  globs silently no-opped (`walkFiles` treated a file root as a directory), so SCHEMA/MODES/README/registry
  and the books were never actually scanned. Post-fix sweep (54 files, was 41) caught + scrubbed one real
  token leak in `registry.json`. Scan set widened via `config.agnosticGuardrail.scanGlobs` (books + master +
  template + propagation map + sweep commands); a git **pre-commit hook** (versioned at `bin/hooks/pre-commit`,
  installed by copy into `.git/hooks/`) now runs the checker on every commit — the ratchet for this class.

## Status (2026-07-08)

- **Layer D — COMPANION BOOKS MERGED (2026-07-08):** the three companion specs (`COUNCIL.md`, `EXTENSIONS.md`,
  `GAMEDEV.md`) are now canonical files in the chip, cross-linked from `SCHEMA.md`, and their machinery is registered
  in `registry.json` (v0.3.0): G0 plan-refine + GC-council + G-import gates; 7 council seats + 6 game-fleet roles;
  the propagation staleness detector family + asset-orphan detector; the council-report/open-items/function-map/
  master-reference/launcher artifact projections. Every book entry ships **dormant** behind a config seam
  (`config.council` / `config.artifacts` / `config.game`), so a fresh repo runs the exact same core loop it did
  before. `config.planRefine` is **on by default** (reasoning gate, no script). `propagation.map.json` chip default
  added. `VALTOR-MASTER.md` regenerated as a stamped projection of all four documents. All JSON re-validated.
  **Contract-complete, implementation-pending:** the book gates run on orchestrator reasoning (`run:null`) until
  `bin/` scripts harden them — the same "spine now, scripts later" bridge as the core judgment gates.

## Status (2026-06-17)

- **Contract-complete (designed in SCHEMA/registry/config):** all of A, B, C above + the Confer interaction mode + the Anticipated-Q&A stakeholder-lens review (C13, SCHEMA §11).
- **Spine landed:** SCHEMA.md, SKILL.md (`/valtor`), valtor.config.json, registry.json, this roadmap; `.gitignore`
  un-ignores the `.claude/` Valtor artifacts.
- **Layer A — BUILT & VERIFIED (2026-06-17):** 9 reference `bin/` scripts (lock, ledger, budget, git-policy,
  plan-drift, scope-check, deploy-health, index-rebuild, init) + shared `lib.mjs`, all `node --check` clean and
  smoke-tested end-to-end (lock HALT-on-contention + full acquire/heartbeat/release lifecycle, scope-escape block,
  budget exhaustion, plan-drift new→unchanged, on-default-branch block, ledger, init gate-detection). Adversarial
  pass caught + fixed a command-injection (git-policy), lock TOCTOU races, and a budget fail-open; hand-verify
  caught + fixed a lock-identity bug. Universal + config-driven → copies to any repo unchanged.
- **Role sub-agents — BUILT (2026-06-18):** all 9 `.claude/agents/valtor-*.md` (pm, dev, reviewer, debugger, data,
  security, qa, devops, designer) — scoped tools (advisory roles read-only), model tiers (opus for reviewer/
  debugger/security), and structured hand-back contracts. A coherence pass verified the cross-role boundaries
  (reviewer ≠ author; debugger/security write nothing; only the orchestrator commits/deploys) and self-healed a
  failed author by creating the missing qa file.
- **Layer-B/C — BUILT & VERIFIED (2026-06-18):** 20 deterministic scripts (8 detectors, 7 projection renderers,
  4 gate runners, `package.mjs` ejector) — all `node --check` clean, NUL-scrubbed, smoke-tested (detectors read real
  code; renderers produce valid artifacts on an empty ledger; eject copies 46 files + a generic template). Registry
  `run`/`render` fields reconciled to the real scripts; judgment gates marked `mode:reasoning`. A latent
  `lib.globToRegex` `**/` bug (silently dropped base-dir files) was found + fixed centrally.
- **CHIP-COMPLETE & TRANSFERABLE:** `node bin/package.mjs --out <dir>` ejects the portable set + a generic config
  template; `README.md` is the drop-into-any-repo guide. Only `valtor.config.json` changes per repo.
- **Optional / remaining:**
  1. **Hooks** — `SessionStart` auto-resume is documented in `README.md`; wire it via `/update-config` when wanted
     (not auto-added, to avoid a hand-written hook mismatching the Claude Code version).
  2. **Dry-run** Valtor on one small real plan end-to-end, then S-RETRO its own first run — the proof it builds.
