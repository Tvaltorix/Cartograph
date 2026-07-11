# Valtor — Canonical Schema & Contract

> **What Valtor is.** A reusable, project-agnostic build engine: drop a plan in, and a **team of role
> sub-agents — coordinated by a tech-lead orchestrator — works it like a software team, on loop, until the
> plan is complete and the repo is healthy.** It enforces the host repo's locked architecture + security,
> keeps a durable ledger of done/remaining/blocked, survives its own failures, sweeps for stale & orphaned
> work, reports the truth about itself, and asks the human only at the real forks. **Re-entrant across
> sessions**, **safe to leave running**, **portable across codebases** — one config file is the only seam.
>
> **Nothing in this file names a repo.** Every repo-specific value (region locks, key counts, domain gates,
> sweep targets, conflict zones, extractors) lives in `valtor.config.json`. The universal files describe the
> *mechanism*; the config carries the *instance*. To drop Valtor into a new repo, you rewrite one file.

- **Entry:** `/valtor <plan-path>` (skill at `.claude/skills/valtor/`), or auto-resume on session start.
- **Config seam:** [`valtor.config.json`](./valtor.config.json) — the only file you edit per repo.
- **Capability registry:** [`registry.json`](./registry.json) — gates, roles, detectors, projections (additive).
- **Ledger:** `.agents/valtor/index/valtor.sqlite` (working set, git-ignored) + committed `*.jsonl` exports
  (`items`, `decisions`, `transitions`, `plans`, `graph`) so the ledger is rebuildable from git.
- **Roadmap / build plan:** [`ROADMAP.md`](./ROADMAP.md) — the prioritized gap list + the A/B/C/D build layers.
- **Companion books (canonical):** [`COUNCIL.md`](./COUNCIL.md) — plan-level advisory seats at S1.5 + S-RETRO ·
  [`EXTENSIONS.md`](./EXTENSIONS.md) — artifact plans (data islands), the FIX→SWEEP→RATCHET guardrail cascade,
  lockstep propagation (no stale data) · [`GAMEDEV.md`](./GAMEDEV.md) — game-dev dispatch fleet + asset-delivery
  contract · [`SWEEPS.md`](./SWEEPS.md) — the two invocable currency/correctness operations (Reconcile +
  Verification) composing the gates. [`VALTOR-MASTER.md`](./VALTOR-MASTER.md) compiles this file + the four
  books — a generated, stamped projection; edit the sources, regenerate it, never hand-edit it.

It **extends** any prior `.agents/` methodology in the host repo (units/waves/conflict-zones/success_criteria/
depends_on) rather than replacing it.

---

## 1. The team (roles → registry → ownership)

Every role is a Claude Code **sub-agent** (`.claude/agents/valtor-*.md`) with its own scope and model tier. The
orchestrator IS the skill. Roles activate per the registry; not every item touches every role.

| Role | Sub-agent | Owns | When |
|---|---|---|---|
| Tech Lead | orchestrator (skill) | State walk, lock, wave/conflict/blast-radius planning, **serial** commit+deploy, conflict-zone edits, **sole writer to every ledger table**, branch policy | always |
| Product/BA | `valtor-pm` | Requirement clarity, **scope boundary**, Definition-of-Ready (G2b), severity assignment, **stakeholder/demo-prep (Anticipated-Q&A §11)**, ambiguity → ask, retro | DECOMPOSE / CLEAR / RETRO / DONE |
| Dev (fleet) | `valtor-dev` | Implementation — the **inner senior-dev cycle**; returns diff + self-report; never commits | DISPATCH |
| **Reviewer** | `valtor-reviewer` | **Independent code review before commit (G4b)** — a *different agent instance* than the author; correctness, convention, reuse, blast radius | INTEGRATE |
| **Debugger** | `valtor-debugger` | **Failure triage (S-DEBUG)** — consult failure catalog → reproduce → isolate → root-cause → hand a fix-spec; reads broad, writes nothing | on any gate FAIL / red deploy |
| Data Eng | `valtor-data` | **DB-constraint principle (G3)**, **migration safety (G3b)**, the ledger schema | CLEAR / INTEGRATE |
| Security | `valtor-security` | **Arch/security invariants (G2)**, negative-authz, dep/secret scan — **has VETO** | CLEAR / DEPLOY |
| QA | `valtor-qa` | Verification (GV), tests + regression + exploratory, **gap audit (G4)**, contract-lockstep (G4c), flaky quarantine, E2E, **stale/orphan sweep (G6)** | RECONCILE-OUT / INTEGRATE / SWEEP |
| DevOps/SRE | `valtor-devops` | Deploy gates (G5/G5.5), one-deploy-at-a-time, CI ordering, rollback, observability | DEPLOY (on CI/infra item) |
| UX Designer | `valtor-designer` | Interface + interaction spec, NFR/a11y gate (G-NFR) | CLEAR (on UI item) |

**The orchestrator invariant (most important rule):** *all work routes through the orchestrator.* Workers return
**diffs + self-reports**; they never commit, never deploy, never write a ledger table, never edit a `conflictZones`
file. The debugger proposes a **fix-spec, not a diff**. The reviewer is **never the same instance** as the author.

Two companion rosters extend the team without touching these invariants: **plan-level advisory seats**
([`COUNCIL.md`](./COUNCIL.md) — read-only; own no gates, write nothing, silent during execution) and the
**game-dev dispatch fleet** ([`GAMEDEV.md`](./GAMEDEV.md) — workers under the same diff-or-delivery +
sole-writer rules; asset deliveries validated by G-import). Both are dormant until their config seams enable them.

---

## 2. The state machine

```
ACQUIRE-LOCK (pre-S0)  atomic lockfile + heartbeat + instance_id. Live lock → S-ASK case 7.
S0  INGEST          hash the plan; G0 plan-refine (read the plan as a structured prompt, §2.1); on re-ingest, plan-drift detector diffs vs stored fingerprint → re-decompose delta
S1  RECONCILE       G1 Reconcile Sweep — inbound (BLOCKING on contradiction)
S1.5 COUNCIL        (config-gated sub-state) advisory seats review the post-G1 plan independently; reconciled findings → AMEND/INJECT/CRITERIA/GATE-PROPOSAL/HALT/QUESTION; max 2 rounds (COUNCIL.md §2)
S2  DECOMPOSE       parse → LoopItems; dedup; set plan_id/phase/domain/severity/priority/demo_path; consult decisions ledger
S3  CLEAR           G2 (arch/sec/scope) + G3-flag (db) + G2b-READY (Definition-of-Ready); designer activates HERE for UI
S4  PLAN-WAVES      topo-sort depends_on; sort within level by (severity,priority); blast-radius over graph; pin contracts
S5  DISPATCH        fork valtor-dev (+designer/devops) PARALLEL within a wave
S6  RECONCILE-OUT   GV verify + G-scope (diff stayed in bounds)
S7  INTEGRATE       per item SERIAL: apply → G3 + G3b + G4 + G4b-review + G4c-contract → commit (on loop/ branch)
S8  DEPLOY          SERIAL: G5 + G5.5-deploy-health → {green | red | cancelled}; one at a time, wait for CI, notify chat
S9  SWEEP           G6 detectors + regenerate system-map (free byproduct of the same extraction)
S10 PROPAGATE       G7 docs+ADR+memory; regenerate board/readiness/blockers/map; reindex; export *.jsonl (serialized)
S11 DONE            tiered done met → merge loop/ branch → main behind green deploy → release lock → go IDLE (re-entrant)

S-ASK    HALT/ASK   cases 1–8; every resolution writes a decisions-ledger row
S-DEBUG  triage     reproduce → isolate → root-cause → fix-spec + class-signature → regression → FIX→SWEEP→RATCHET (EXTENSIONS.md Part 2); bounded by config.budget; returns to raiser
S-RETRO  learn      at phase/plan completion: emit Anticipated-Q&A (§11) + propose registry additions + bin/ codification; folds into review summary
```

**S-DEBUG, S-RETRO, ACQUIRE-LOCK — plus the config-gated S1.5 COUNCIL — are the only additions to the labeled
set**, implemented as sub-loops/sub-states that **return to their raising state** (the same proven pattern as
S-ASK); S1.5 is skipped entirely when `config.council.enabled` is false. Everything else is a *gate within an
existing state*. This honors the law: **grow by adding a registry entry, never by editing the state machine.**

### 2.1 G0 — plan-refine on ingest (read the plan as a structured prompt)

Plans arrive as rough asks. At S0, before reconcile/council/decompose, the orchestrator (PM hat) reads the plan
through the **prompt-anatomy checklist**: the objective *and the why behind it* · scope + YAGNI · hard constraints ·
per-item **"Done means"** criteria · verification built in (the human is never the QA) · defects/asks batched into
ONE set (never one-per-round) · stop conditions. Where the human's user-scope **`refine-prompt` skill** is available,
G0 invokes it to run this pass; where it is not, the orchestrator reasons the checklist inline — same bridge as every
other reasoning gate, recorded in `gate_results` either way (a gate is never silently skipped).

Outputs: inferred why/criteria annotations flow into decomposition, so **G2b has real machine-checkable targets**
instead of discovering their absence later; genuinely ambiguous goal/audience/constraints → **HALT case 3 (confer)
before decompose, as one batched question set** — never mid-wave. G0 amendments change the plan text, so S0's hash +
drift detector re-decompose only the delta — the same mechanics as Council AMENDs. Config seam: `config.planRefine`.

**Triggers:** S-DEBUG ← any blocking gate (GV/G4/G4b/G4c/G5/G5.5) returns FAIL, or a worker flags success_criteria
unmet, or S8 goes red — bounded by `config.budget`; exhaustion → S-ASK case 8. S-RETRO ← phase/plan completion (it
*is* the review-summary moment; no new pause). ACQUIRE-LOCK + plan-drift ← once before S0 and on every re-entry.

**Two sweeps, opposite directions:** S1 inbound (does the plan contradict our docs?) and S9 outbound (did our work
leave the repo with orphans/stale?). **Re-entrancy:** on session start, read the ledger; resume at the lowest
incomplete state (never restart at S0); if the SQLite index is missing, rebuild it from the committed `*.jsonl`.

---

## 3. The `LoopItem` record

One shape so dedup / relatedness / orphan / readiness queries are uniform. Superset of the proven `.agents/` unit.

```jsonc
{
  "id": "BUG-018 | FEAT-009 | synthesized-slug",            // ID-first identity
  "kind": "plan_item|knowledge|doc_anchor|code_unit|event_route|migration|contract|orphan_candidate",
  "goal": "embeddable one-line summary",  "text": "fuller description",  "embedding": null,
  "status": "open|in_progress|debugging|done|deferred|question|superseded|stale|orphan",
  "source_files": [], "scope_files": [], "readonly_files": [],
  "success_criteria": [ "MUST be machine-checkable: a test, a grep, a 401, a DB constraint" ],
  "depends_on": [], "related": [], "implements": [],         // implements: plan_item → route/ui/migration (graph)
  "referent_path": "...", "referent_kind": "route|ui|event|migration|doc|adr|memory",
  "last_seen_commit": "sha", "content_hash": "of cited region (staleness)",
  "source": "origin plan / ADR / test-case id", "confidence": 0.0, "first_seen": "iso", "last_verified": "iso",

  // posture + bucketing: set at S2
  "mode": "build|architect|audit|refactor|optimize|debug|plan",   // operating mode (MODES.md §12); lenses compose as phases
  "plan_id": "", "phase": "", "domain": "", "demo_path": false, "demo_tag": null, "out_of_scope": false,
  // ordering + budget
  "severity": "P0|P1|P2", "priority": 0, "size": "xs|s|m|l|xl", "risk": "low|med|high",
  "attempt_count": 0, "debug_iterations": 0, "last_failure": { "cause_hypothesis": "", "file_line": "", "gate_id": "" },
  // readiness + blocking
  "ready": false, "ready_blockers": [], "blocked_by_subtree_root": null
}
```

**Dedup on ingest (S2):** ID-first → embedding-similarity → `referent_path`. A re-dropped plan never duplicates
tracked work. **`success_criteria` must be machine-checkable** — if not, that's an S-ASK to the PM.

### 3.1 Ledger tables (orchestrator is sole writer; `valtor-data` owns the schema)

```jsonc
gate_results      { item_id, gate_id, state, outcome:"pass|fail|halt|surfaced|skipped-codify-pending",
                    run_kind:"script|orchestrator-reasoning", detail, commit_sha, ts }   // feeds readiness/blockers/burn-down
status_transitions{ item_id, from_status, to_status, ts, commit_sha }                    // burn-down / velocity / ETA
decisions         { id, item_id?, halt_case:"1-8", question, options_presented[], answer,
                    answered_by, answered_at, scope:"this-item|this-plan|standing", graduated_to:"null|ADR-NNNN|memory:<file>" }
failures          { id, item_id, gate_id, symptom, cause_hypothesis, file_line, attempted_diffs[],
                    resolution, status:"open|workaround|fixed|flaky", commit_ref, first_seen, last_seen,
                    guardrail:{ kind:"detector|gate|test|lint|ci-check|reasoning", ref, status:"emitted|graduated|waived", note } }   // class-level prevention; a fix is not "fixed" without it (G-guardrail, §7 done bar)
plans             { plan_path, plan_sha256, section_hashes[], ingested_at, decomposed_item_ids[] }   // plan-drift
edges             { from, from_kind, to, to_kind, edge, source_extractor, last_seen_commit }          // the graph
contracts         { id, shape_kind:"event|route|migration", shape, sides:[item_ids], pinned_at }      // inter-item lockstep
run_journal       { ts, instance_id, run_id, state, action, item_id?, gate_id?, gate_mode, deploy_run_id?, outcome,
                    budget_counters, halt_case?, decision_id? }                                       // self-audit (git-ignored)
concerns          { id, stakeholder_id, concern, weight, source:"config-seed|asked-question|inferred",
                    first_seen, last_seen, example_questions[] }                                      // learned stakeholder model (§11)
```

Committed exports: `items.jsonl`, `decisions.jsonl`, `transitions.jsonl`, `plans.jsonl`, `graph.jsonl`, `concerns.jsonl` —
plus, when their seams are enabled, `council.jsonl` (seat reports; COUNCIL.md §5) and `dirty.jsonl` (the propagation
dirty set; EXTENSIONS.md §3.4). Git-ignored:
`valtor.sqlite`, `valtor.lock`, `run_journal.jsonl`. The SQLite is rebuildable from the exports + git + plan.

---

## 4. Gates — where each fires (live list in `registry.json`)

| Gate | State | Block | Owner | Intent |
|---|---|---|---|---|
| **G0 Plan-Refine** | S0 | yes→ASK | pm | read the plan as a structured prompt (§2.1): why + "Done means" criteria + machine-checkable verification inferred; genuine ambiguity → one batched confer, before decompose (config.planRefine; invokes the `refine-prompt` skill when available) |
| G1 Reconcile Sweep | S1 | yes | orchestrator | inbound doc sweep; auto-fix cosmetic drift, HALT on contradiction |
| **GC-Council** | S1.5 | yes→ASK | orchestrator | (config-gated) independent advisory-seat reviews of the post-G1 plan, reconciled by the orchestrator → AMEND/INJECT/CRITERIA/GATE-PROPOSAL/HALT/QUESTION; ≤2 rounds (COUNCIL.md) |
| G2 Arch/Sec/Scope | S3 | yes→ASK | security | region, language-ADR, **scope boundary**, keys, identity, no-PII-logs (all from config) |
| **G2b Definition-of-Ready** | S3 | yes→ASK | pm | depends_on satisfied/contract-pinned; UI item has a designer spec; success_criteria complete; referent resolved |
| G3 DB-Constraint | S3+S7 | yes | data | paired DB constraint for any domain column |
| **G3b Migration-Safety** | S3+S7 | yes | data | down-pair exists; backfill on populated table; destructive-on-real-data → HALT; migrate-before-deploy |
| GV Verify | S6 | yes/item | qa | reproduce success_criteria; Verify-Before-Concluding on pivots |
| **G-scope** | S6 | yes | orchestrator | worker diff ⊆ scope_files, ∉ conflictZones/readonly; escape → reject (conflict-zone hunk → orchestrator applies) |
| G4 Test/Gap | S7 | yes | qa | item tests + every plan line maps to done/deferred |
| **G4b Code-Review** | S7 | yes | reviewer | fresh instance reads the diff before commit; P0/P1 finding → re-dispatch |
| **G4c Contract-Lockstep** | S7 | yes | qa | event/route/migration lockstep on the integrated diff (one side without the other → block) |
| G5 Deploy (smoke + neg-authz) | S8 | yes | devops/security | autodetect + scaffold-if-absent; one-deploy-at-a-time |
| **G5.5 Deploy-Health** | S8 | yes | devops | poll smoke + canary post-deploy → green/red/cancelled; red → revert-on-branch + S-DEBUG |
| G6 Stale/Orphan | S9 | **surfaces** | qa | detectors → ask; never auto-act; absorbs every ratcheted class signature + the staleness detector family (EXTENSIONS.md §3.6) + asset-orphan detectors on game repos (GAMEDEV.md §3) |
| G7 Propagate | S10 | yes | orchestrator | docs + ADR + memory + projections in lockstep; when propagation seams are enabled: **dirty set empty + fingerprint audit** — every registered surface's `generated_from` equals ledger head (EXTENSIONS.md Part 3) |
| **G-NFR** | S7 | when UI/perf | designer | a11y / perf budget / i18n from config.nfrBudgets |
| **G-E2E** | S8/phase | when flow declared | qa | run config.e2e dry-run, else reason the named flow against staging |
| **G-Observability** | S8 | **surfaces** | devops | new route/event/task has a metric + alarm + owner |
| **G-behavior-lock** | S7 | when audit/refactor/optimize | qa | same tests green before + after — behavior must not change (mode constraint) |
| **G-guardrail** | S7 (post-S-DEBUG) | yes | qa/debugger | a resolved failure emitted a **class-level** guardrail (detector / gate / lint / CI-check that prevents the whole *class*) — an instance regression test alone is insufficient — or a logged `waived` with reason; reasoning-only guardrails graduate to a `bin/` detector at S-RETRO. **Cascade form (EXTENSIONS.md Part 2):** closure = instance fix + sibling **sweep** executed with recorded result + guardrail installed **green** — any missing link blocks |
| **G-import** | S7 | yes | engine worker | (game seam) receiving engine worker validates each asset delivery in-engine — scale, orientation, skinning, one clip playing, material assignment; FAIL re-dispatches to the exporter; importer ≠ exporter (GAMEDEV.md §3) |
| **G-engine-agnostic** | S10 (on engine edit) | yes | orchestrator | when a universal Valtor file changed this run, `bin/check-project-agnostic.mjs` finds zero host instance data (repo tokens · account/ARN/region/email/home-path · config-value literals) — keeps the loop portable |

**Gate execution rule (the "spine now, scripts later" bridge):** a gate's `run` script under `bin/` is its
**hardened** form. **If the script is absent, the orchestrator performs the gate's `intent` by reasoning + ad-hoc
tools, records `run_kind:"orchestrator-reasoning"` in `gate_results`, and flags it for codification.** A gate is
never silently skipped. (Layer-A ships entirely in reasoning mode — `bin/` is built incrementally.)

---

## 5. Detectors, orphans & the system graph

**Unifying reframe:** *each extractor emits a typed edge list; an orphan is an extractor-edge with a missing
endpoint; the system map is the UNION of all extractor edge lists.* Same computation, two surfaces — the sweep and
the map never run separate extraction passes (that would be a drift source on the most-trusted surface).

Orphan/stale classes (structural first; the vector layer only does fuzzy relatedness/dedup; all **surfaced** at S9):
- **route-no-UI / UI-no-backend** — backend route table ⟷ UI call sites.
- **plan-item-no-commit** — `status != done` and no commit references its id.
- **event-no-handler** — detail-type present in < all of {emitter, fan-out router, UI subscriber}.
- **migration-no-model** — column/table never queried, or missing its DB constraint.
- **doc-stale** — referent changed since `last_verified`, cited `file:line` gone, or a superseding record exists.
- **code-stale (zero-inbound)** — dormant until an import graph exists; emits a removal-candidate list only.
- **plan-drift / flaky-criterion / shared-node-collision** — drift + planning detectors (see registry).

### 5b. The graph projection (`system-map`)
**8 node kinds:** service, route, ui_surface, event_detail_type, migration, table, adr, plan_item. **9 edge kinds:**
calls, routes_to, emits, consumes, persists_to, depends_on, supersedes, **governed_by** (provenance), **implemented_by**.
Two artifacts, one pass: committed Mermaid `system-map.md` (humans) + `graph.jsonl` (the orchestrator greps it for
**blast-radius** at S4). **Degraded mode:** each edge kind is independently optional; an absent extractor seam omits
that edge with a one-line note; minimum viable map = routes + UI + migrations.

---

## 6. When Valtor HALTS — and how it confers

Autonomy = **interrupt-when-needed + review summaries**: hands-off, pausing only for —

1. **Scope boundary** — item outside `config.archGates.phaseBoundary` and not already built → the scope authority owns it.
2. **Locked-arch touch** — new region, new language outside policy, new key, identity/auth change, any locked decision → needs a decision record / sign-off.
3. **Ambiguous item** — no resolvable `referent_path`, or `success_criteria` not machine-checkable (fails G2b).
4. **Unresolved doc contradiction** (S1) — two anchors assert conflicting current direction.
5. **Security veto** — `valtor-security` blocks an item.
6. **New orphan needing action** (S9) — route-no-UI / event-no-handler / migration-no-constraint surfaced.
7. **Live lock** — another Valtor instance holds the lock (and isn't stale).
8. **Effort budget exceeded / stuck item / oscillation** — debug/retry/deploy ceiling hit, or a fix re-breaks a sibling twice.

It also **stops and presents a review summary** at each phase completion and at plan completion (reports, not approval
gates) — that summary embeds the S-RETRO output.

### 6.1 Interaction mode — Confer by default (`config.humanInteraction`)

**A halt is a conversation, not a form.** Default mode is **`confer`**: the orchestrator posts a **Decision Brief** —
(1) the decision in one line, (2) why it surfaced now, (3) the real options with their tradeoffs, (4) its
recommendation + reasoning, (5) the specific judgment it needs from the human — ending with a **scannable recap-menu**
of the options — then **STOPS and awaits free text.** The human may pick, push back, reframe, or ask it to dig deeper;
**nothing locks until they converge.** **`quickpick`** mode (the blocking multiple-choice form) is reserved for
genuinely small/binary confirmations only. On convergence the orchestrator **logs the decision and proceeds**,
surfacing the one-line record in the next review summary. **Every resolution writes a `decisions` row**;
standing/architectural answers graduate to a decision record + memory so a re-entry never re-asks.

---

## 7. Definition of done (tiered, bounded, re-entrant)

- **Now:** `plan-complete + repo-healthy` — every item `done`/`deferred`, all blocking gates green, the stale/orphan +
  gap audit clean. Any **declared E2E flow** must be green.
- **Guardrail ratchet:** no `failures` row left in `fixed` without a `guardrail` (`emitted`/`graduated`) or an explicit
  logged `waived` — every resolved failure has become class-level immunity, not a one-off patch (G-guardrail); under
  the cascade (EXTENSIONS.md Part 2) that means the full chain: fix + recorded sibling sweep + green ratchet. And if a
  universal engine file was edited this run, **G-engine-agnostic** is green (the loop stayed portable).
- **No stale surfaces:** when the artifact/propagation seams are enabled, done additionally requires the **dirty set
  empty** and every registered projection's `generated_from` fingerprint at ledger head (G7, EXTENSIONS.md Part 3).
- **Auto-upgrade:** once a deploy gate is registered + active, done also requires a **green staging deploy**, and the
  `loop/` branch merges to the default branch only at S11 behind that green deploy.
- **Bounded:** `config.budget` caps convert a silent grind into an explicit HALT + triage report.
- **Done is idle, not termination.** Valtor re-enters with prior context (ledger + memory) on the next plan.

---

## 8. Portability, placement & rebuild

- **Tracked in git** (the methodology must be shareable): `.gitignore` selectively un-ignores `.claude/skills/`,
  `.claude/agents/`, `.claude/commands/`, `.claude/settings.json`; git-ignores the SQLite index, lock, and run-journal.
- **Portable file set** to drop into any repo: `.claude/skills/valtor/`, `.claude/agents/valtor-*.md`,
  `.agents/valtor/{valtor.config.json,registry.json,SCHEMA.md,ROADMAP.md,bin/}`. **Only `valtor.config.json` changes per repo.**
- **Bootstrap into a fresh repo:** point `config.masterContext` at the repo's context doc; flip `archGates` off or
  rewrite them; rewrite `extractors` for the repo's frameworks; rebuild `conflictZones` from the import graph + CI/IaC
  fan-in; detect deploy-gate scripts (wire if present, scaffold minimal if absent); probe map seam coverage.
- **Index rebuild:** the SQLite working set is reconstructable from the committed `*.jsonl` exports + git log + a plan
  re-decompose. Re-entry auto-runs the rebuild if the SQLite is missing. The rebuildability promise is real, not aspirational.

**Quickstart — drop into a new repo:**
```
copy  .claude/skills/valtor/  +  .claude/agents/valtor-*.md  +  .agents/valtor/{SCHEMA.md,registry.json,bin/}
edit  .agents/valtor/valtor.config.json     # the only per-repo seam
run   node .agents/valtor/bin/init.mjs      # creates the ledger + detects deploy gates
then  "Hello Valtor"  or  /valtor <plan>
```
The Layer-A safety scripts (lock · budget · git-policy · scope-check · deploy-health · plan-drift · ledger ·
index-rebuild · init) are universal — they read every specific from the config and never change per repo. See
`.agents/valtor/bin/README.md` for the CLI contract.

---

## 9. Absorbing a host repo's existing disciplines

Valtor maps a repo's existing protocols onto its gates — bind them in `valtor.config.json`, don't reinvent them:
reconcile/propagate disciplines → G1/G7; verify-before-pivot → GV; session-continuity → S10 + re-entry; one-deploy-
at-a-time → S8; emission/handler lockstep → the event-no-handler detector + G4c; DB-constraint + CI-sequencing
principles → G3/G3b/G5. The config records which repo files/memories carry each discipline.

---

## 10. Readiness model

`config.readinessModel.dimensions` scored 0–100 from `gate_results`, **overall = `min()` (not mean)** — a project is
only as ready as its weakest dimension. Default dimensions: **BUILD** (items integrated / total in-scope), **TEST**
(G4/GV pass rate), **INTEGRATION** (G4c + E2E), **DEPLOY** (G5/G5.5 green), **DEMO-READY** (`demo_path` items done +
E2E green), **SECURITY-CLEAR** (G2 + negative-authz, zero open vetoes). **One honest denominator:** `total = sum of
all statuses`; `out_of_scope` items are excluded from the denominator and listed separately; `deferred` stays in the
denominator as its own column. No silent truncation — the % never lies.

---

## 11. Stakeholder-lens review — Anticipated Q&A (`config.anticipatedQa`)

Technical readiness (§10) asks *"is it built / tested / deployed?"* This asks **"can it survive the room?"** At
every phase completion — and on demand (*"prep me, I'm about to present this"*) — the PM hat emits an
**Anticipated-Questions brief** (the `anticipated-qa` projection → `QA-BRIEF.md` + a section in the review summary):

- **Predict** the questions each stakeholder is likely to ask, cross-referencing what *changed* this phase (items,
  success_criteria, diffs, gate_results, blockers) against what each `config.stakeholders` entry *cares about*. Two
  tagged lenses: **stakeholder/demo** (the room — scope-authority / client-exec / QA / end-user) and **skeptic** (a
  reviewer attacking the *quality* of the work).
- **Answer** each predicted question, grounded in the ledger + diffs + which gates passed. Where it **can't** answer,
  it flags the question → that becomes a confer item or a new work item: *the gap the demo would have exposed, caught
  before the demo.*
- **Learn.** Questions actually asked in a review/demo — and the human's answers — are recorded into the `concerns`
  ledger, sharpening the stakeholder model each phase. Over time Valtor accumulates a real model of what matters to
  the principal and the project, so it pre-answers questions neither party scripted. This learning loop is what makes
  the review *anticipatory* rather than a static checklist.

Stakeholders + lenses + firing triggers are all configured in `config.anticipatedQa` + `config.stakeholders`; a fresh
repo seeds its own audiences. The brief is the stakeholder-readiness companion to the technical-readiness BOARD (§10).

---

## 12. Operating modes (`registry.json` → modes + MODES.md)

A **mode** is the senior-engineer posture Valtor adopts for a piece of work, selected at **S2** from the plan's
intent (→ `LoopItem.mode`). It is a thin layer the existing loop *executes* — not a separate engine. **7 primary
modes** (pick one per plan): **BUILD** (architecture-first MVP), **ARCHITECT** (scalable system/infra design),
**AUDIT** (reverse-engineer → assess), **REFACTOR** (clean-architecture restructure), **OPTIMIZE** (perf for scale),
**DEBUG** (root-cause a failure — the S-DEBUG posture), **PLAN** (decide before building — the tech-lead as a task).
**3 specialist lenses** compose as a *phase* of a primary mode (postures on existing roles): **FRONTEND** (designer),
**SECURITY** (security — has veto), **DEPLOY** (devops). Full playbooks: `MODES.md`.

**Wiring (all reasoning-driven — no new machinery):** a mode's **deliverables become `success_criteria`** (QA G4
enforces them); its **understand-step is its own wave** — architecture / reverse-engineer / root-cause / design must
complete (and pass **G2b-Ready** for BUILD/ARCHITECT) *before* any implementation wave dispatches; its
**constraints are gates** (AUDIT/REFACTOR/OPTIMIZE behavior-preservation = **G-behavior-lock**: same tests green
before + after; DEBUG's no-guess = Verify-Before-Concluding). Deliverables point at **existing** artifacts
(system-map, failures ledger, BLOCKERS, readiness) — no parallel outputs. One primary mode per item; lenses attach
as phases; never two primary modes at once.

**The tech-lead ethos is the orchestrator's standing baseline across every mode** — understand deeply, confer on
ambiguity, challenge weak decisions, prioritize simplicity, think in tradeoffs + scale, produce production-grade
output, never guess. Declared once in `MODES.md`; enforced by the orchestrator + reviewer + QA. It is what makes
Valtor behave like a tech lead, not a code generator.
