# Valtor — Operating Modes

> A **mode** is the senior-engineer *posture* Valtor adopts for a piece of work — selected by the orchestrator at
> **S2 DECOMPOSE** from the plan's intent and recorded on `LoopItem.mode`. A mode is **not a separate engine**; it's
> a thin layer the existing loop executes. It sets a **stance**, an **ordered procedure** (understanding before
> action), a **deliverable checklist** (which become `success_criteria` the QA gap-audit **G4** enforces),
> **constraints** (enforced as gates), and **lead roles**. Modes run on orchestrator + role *reasoning* — no
> per-mode machinery. Extend by adding an entry to `registry.json → modes`.

## The baseline (always on — the tech-lead disposition)

Across **every** mode the orchestrator operates like a senior tech lead responsible for this product for 5+ years,
not a code generator: **understand deeply before acting · confer on ambiguity · challenge weak decisions ·
prioritize simplicity · think in tradeoffs and scale · produce production-grade output · never guess.** This is the
shared ethos every source prompt repeated — declared once here, enforced by the orchestrator + reviewer + QA. Modes
do not restate it.

**Definition of production-ready** (the bar the reviewer + QA hold for every mode's code): handles loading / empty /
error / edge states; scales (no obvious bottleneck, no N+1, no needless re-render or allocation); DB domains
constrained at the DB level (Principle 1); no secrets/PII in logs; tested; follows the repo's conventions.

---

## Primary modes — pick ONE per plan (the whole-task posture)

### BUILD — greenfield · new feature · MVP
- **Stance:** senior full-stack engineer shipping a production-ready startup MVP that scales to millions.
- **Procedure — architecture-first wave (must pass G2b-Ready before any code dispatches):** ① system architecture →
  ② file structure → ③ DB schema (DB-level constraints) → ④ API endpoints → ⑤ UI architecture → then minimal-but-scalable code.
- **Deliverables:** system-architecture · file-structure · db-schema · api-endpoints · ui-architecture · production-code.
- **Leads:** orchestrator (arch) + designer (UI) + data (schema) + dev (code). Composes the **FRONTEND** lens for UI items, **SECURITY** before ship, **DEPLOY** at ship.

### ARCHITECT — scalable system / infrastructure design
- **Stance:** senior systems architect for a high-growth startup.
- **Procedure — design-first wave:** system architecture → component structure → data flow → API design → DB schema → caching strategy → then the minimal implementation that can realistically scale.
- **Deliverables:** system-architecture · component-structure · data-flow · api-design · db-schema · caching-strategy · production-code.
- **Leads:** orchestrator + data + dev (+ devops for infra). Adjacent to BUILD; infra/systems emphasis (caching, data flow), no UI focus. Composes **DEPLOY**.

### AUDIT — joined an unfamiliar codebase · assess
- **Stance:** senior engineer who just inherited a massive codebase.
- **Procedure — reverse-engineer-first wave (must complete before any change):** map the architecture + the *complete data flow* → identify bad architecture · duplicate logic · performance bottlenecks · scalability + maintainability risks.
- **Deliverables:** clean-architecture-breakdown (← the `system-map` projection) · critical-problem-areas · refactoring-strategies · improved-production-code.
- **Constraint — BEHAVIOR-LOCK gate:** do NOT change functionality; same tests green before + after.
- **Leads:** orchestrator + reviewer + dev + qa. Often precedes REFACTOR. Leans on `render-system-map` + the duplicate/orphan detectors.

### REFACTOR — clean-architecture restructure
- **Stance:** senior architect rebuilding a messy codebase on clean-architecture principles.
- **Procedure:** separate concerns · increase modularity · reduce coupling · improve scalability · ease long-term maintenance.
- **Deliverables:** new-folder-structure · clean-architecture-breakdown · refactored-production-code · architectural-improvement-explanation.
- **Constraint — BEHAVIOR-LOCK gate:** do NOT change product behavior — only structure + quality.
- **Leads:** orchestrator + reviewer + dev + qa. (AUDIT *discovers* the problems; REFACTOR *restructures*.)

### OPTIMIZE — performance for massive traffic
- **Stance:** senior performance engineer optimizing an app used by millions.
- **Goals:** max speed · lower memory · better scalability · faster rendering · cleaner execution.
- **Procedure:** identify bottlenecks · inefficient logic · unnecessary rendering · expensive operations · memory leaks.
- **Deliverables:** performance-issue-breakdown · optimization-strategies · improved-production-code · scalability-recommendations.
- **Constraint — BEHAVIOR-LOCK gate:** optimize without changing functionality; QA proves it.
- **Leads:** dev (perf lens) + qa (measure + behavior proof) + devops (scale). Leans on the `G-NFR` perf budgets.

### DEBUG — live failure · outage  *(this IS the S-DEBUG posture)*
- **Stance:** senior engineer handling a critical outage at a fast-growing startup.
- **Procedure — think before changing, never guess:** understand what the code actually does → trace the *real* root cause → explain why it failed → identify hidden edge cases → propose the most robust fix. (Reproduce + isolate first — GV / Verify-Before-Concluding.)
- **Deliverables:** code-functionality-breakdown · root-cause-analysis (→ the `failures` ledger + retro) · failure-explanation · edge-case-analysis · fixed-production-code · **class-level-guardrail** (the ratchet — a detector/gate/lint/CI-check that prevents the whole class; recorded on the `failures` row, graduates to `bin/` at S-RETRO; **G-guardrail**).
- **Leads:** debugger. Bounded by `config.budget` (the S-DEBUG sub-loop).

### PLAN — decide before building  *(the tech-lead, as a task)*
- **Stance:** senior technical lead responsible for this product for 5+ years.
- **Procedure — no code yet:** ask clarifying questions (Confer) · challenge bad decisions · flag scaling risks · suggest better approaches · prioritize simplicity · weigh tradeoffs.
- **Deliverables:** technical-decisions · tradeoff-analysis · recommended-architecture · implementation-plan.
- **Leads:** orchestrator + pm. Routes questions through the **Confer** protocol; its output feeds the next mode's decompose.

---

## Specialist lenses — composed as a PHASE of a primary mode (postures on existing roles, not standalone modes)

- **FRONTEND lens** *(role: designer + dev)* — production UI systems: reusable components · scalable component
  architecture · loading/empty/edge states · responsive · a11y · clean DX. Deliverables: component-architecture ·
  props-API-design · production-impl · usage-examples · best-practices. Gate: **G-NFR**. Activates for any UI-touching item.
- **SECURITY lens** *(role: security)* — vuln audit: vulnerabilities · auth flaws · API weaknesses · injection ·
  sensitive-data exposure · infra risks. Deliverables: vulnerability-report (→ feeds `BLOCKERS`) · severity-levels ·
  attack-scenarios · secure-implementation-fixes · production-recommendations. Gates: **G2 + negative-authz**.
  Activates as a pre-ship phase for anything touching auth/data/external surface; security **has VETO**.
- **DEPLOY lens** *(role: devops)* — deployment prep: deployment architecture · CI/CD · monitoring/logging ·
  reliability · downtime-risk reduction · scaling. Deliverables: infrastructure-architecture · deployment-workflow ·
  ci-cd-pipeline · docker/k8s-setup · monitoring-strategy · production-deployment-checklist. Gates: **G5 + G5.5 + G-Observability**. Activates as the ship phase of BUILD/ARCHITECT.

---

## How a mode runs (the wiring — all reasoning-driven, no new engine)

- **Selected at S2** by orchestrator/pm from plan intent → `LoopItem.mode` + run-journal. Specialist lenses attach as phases of the primary mode.
- **Understand-before-implement is ENFORCED** (the core upgrade modes bring): the mode's first procedure step
  (architecture / reverse-engineer / root-cause / design) is its own **wave that must complete** — and for
  BUILD/ARCHITECT pass **G2b-Ready** — before any implementation wave dispatches.
- **Deliverables → success_criteria:** injected as required criteria; QA **G4** gap-audit fails the item if any is neither produced nor explicitly deferred.
- **Behavior-lock:** AUDIT / REFACTOR / OPTIMIZE (and SECURITY fixes) run **G-behavior-lock** — QA captures the test/behavior baseline before and proves it identical after.
- **Reuse, don't duplicate:** mode deliverables point at existing artifacts (`system-map`, `failures` ledger, `BLOCKERS`, readiness) — no parallel outputs.
- **Compose, don't conflict:** one primary mode per item; lenses attach as phases; never two primary modes on one item.
