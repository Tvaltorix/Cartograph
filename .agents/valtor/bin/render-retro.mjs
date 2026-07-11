#!/usr/bin/env node
// render-retro.mjs — projection 'retro' (registry.json) → HOME/retro-latest.md.
//
//   node render-retro.mjs
//
// The S-RETRO learning surface (SCHEMA §2 S-RETRO, §4 gate-execution rule, registry projection
// 'retro'). At phase/plan completion the orchestrator emits a retrospective: which gates it had to
// run by *reasoning* (because no hardened bin/ script exists yet — candidates to codify), what
// failure patterns are recurring, and which orphans got surfaced. It then proposes concrete
// registry/bin/ additions so the next pass is faster + more deterministic.
//
// What "retro" reads (the spec):
//   * gate_results WHERE run_kind == "orchestrator-reasoning"  → gates that ran on reasoning. Each
//     distinct gate_id here is a CANDIDATE TO CODIFY into a bin/ script (SCHEMA §4: "a gate's run
//     script under bin/ is its hardened form … if the script is absent, the orchestrator performs
//     the gate's intent by reasoning, records run_kind:'orchestrator-reasoning', and flags it for
//     codification"). We also fold in gate_results whose outcome is the literal
//     "skipped-codify-pending" marker (SCHEMA §3.1) — an explicit codification flag.
//   * failures                                                 → recurring failure patterns: group
//     by a normalized signature (gate_id + symptom/cause family) and rank by recurrence; surface
//     still-open ones first.
//   * surfaced orphans                                         → gate_results / detector rows with
//     outcome == "surfaced" (G6 surfaces, never auto-acts — SCHEMA §4 G6). Listed so the human can
//     act on them.
//
// What it PROPOSES (grounded in the above, never invented):
//   * For each reasoning-only gate_id → "add a bin/<run> script" using the registry's recorded
//     `run` target for that gate (so the proposal names the exact file the registry already points
//     at), or a generic bin/<slug>.mjs when the gate isn't in the registry.
//   * For each recurring failure signature → "append to the failure catalog" (config.propagation.failures).
//   * For each surfaced-orphan class → the confer/work-item it implies.
//
// RENDERER CONTRACT (registry projection):
//   * Writes ONLY its single 'out' artifact (HOME/retro-latest.md). Touches nothing else in the tree.
//   * Reports, never blocks: ALWAYS exit 0 (even on an empty ledger or a write hiccup it reports).
//   * Reads every repo-specific value from loadConfig(); nothing repo-specific is hardcoded.
//
// GRACEFUL DEGRADATION (the headline requirement):
//   * Empty ledger / no matching rows / missing config key / git-absent → a VALID
//     "nothing to retro yet" retro-latest.md is still written, exit 0. Never a stack trace.

// We deliberately avoid lib's loadConfig()/readRows(): both call lib.fail() → process.exit(1) on a
// missing/corrupt config or a single corrupt jsonl row, which try/catch CANNOT trap (it's a process
// exit, not a throw). A renderer must degrade gracefully — still write a valid artifact and exit 0 —
// so we read the config + ledgers with local defensive readers (the same pattern render-readiness.mjs
// and render-blockers.mjs use). INDEX/HOME/CONFIG_PATH/nowIso/tryGit/out are pure helpers.
import { INDEX, HOME, CONFIG_PATH, nowIso, tryGit, out } from './lib.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------------------------
// The retro is scoped to reasoning-mode work. SCHEMA §3.1 gate_results.run_kind enum.
// ---------------------------------------------------------------------------------------------
const REASONING_RUN_KIND = 'orchestrator-reasoning';
// SCHEMA §3.1 gate_results.outcome enum. These two are the codification/surface signals.
const OUTCOME_CODIFY_PENDING = 'skipped-codify-pending';
const OUTCOME_SURFACED = 'surfaced';
// failures.status enum (SCHEMA §3.1). open/workaround are still-live; fixed/flaky are settled-ish.
const OPEN_FAILURE_STATUSES = new Set(['open', 'workaround']);

// ---------------------------------------------------------------------------------------------
// Defensive config read — returns {} on absent/corrupt config instead of exiting the process.
// ---------------------------------------------------------------------------------------------
function readConfigSafe() {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch {
    return {}; // corrupt config → fall back to defaults, still render
  }
}

// ---------------------------------------------------------------------------------------------
// Defensive jsonl reader: survey every line, skip + count corrupt ones, never throw, never mutate
// the file. Absent/empty → { rows:[], corruptLines:[], missing:true }. Mirrors render-blockers.mjs.
// ---------------------------------------------------------------------------------------------
function surveyTable(table) {
  let p;
  try { p = join(INDEX, `${table}.jsonl`); } catch { return { rows: [], corruptLines: [], missing: true }; }
  if (!existsSync(p)) return { rows: [], corruptLines: [], missing: true };
  let raw;
  try { raw = readFileSync(p, 'utf8'); }
  catch { return { rows: [], corruptLines: [], missing: true }; }
  const rows = [];
  const corruptLines = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    try { rows.push(JSON.parse(line)); }
    catch { corruptLines.push(i + 1); }
  }
  return { rows, corruptLines, missing: false };
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------
const lc = (s) => String(s == null ? '' : s).toLowerCase();

function escMd(s) {
  // Keep Markdown table cells from breaking on a literal pipe or a newline.
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function truncate(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function ageHours(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.round(((Date.now() - t) / 36e5) * 10) / 10; // one decimal
}

// Derive a bin/ script slug from a gate id: "G2b-ready" → "gate-g2b-ready". Used only when the
// registry has no recorded `run` target for the gate (a gate the orchestrator reasoned through but
// that isn't registered — still worth proposing a home for).
function gateToBinSlug(gateId) {
  const cleaned = lc(gateId).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `bin/gate-${cleaned || 'unnamed'}.mjs`;
}

// ---------------------------------------------------------------------------------------------
// Registry lookup: map a gate_id → its registered `run` target so a "codify this" proposal can name
// the exact file the registry already points at. Defensive: registry may be absent/corrupt.
// ---------------------------------------------------------------------------------------------
function readRegistryGateRuns() {
  // registry.json lives next to the config seam (HOME/registry.json).
  const byGate = new Map(); // gate_id -> { run, intent, active }
  try {
    const p = join(HOME, 'registry.json');
    if (!existsSync(p)) return byGate;
    const reg = JSON.parse(readFileSync(p, 'utf8'));
    const gates = Array.isArray(reg && reg.gates) ? reg.gates : [];
    for (const g of gates) {
      if (g && g.id != null) byGate.set(String(g.id), { run: g.run || null, intent: g.intent || null, active: g.active });
    }
  } catch {
    // corrupt/absent registry → no enrichment, still render
  }
  return byGate;
}

// ---------------------------------------------------------------------------------------------
// Source 1: reasoning-mode gates → codification candidates.
// Group reasoning-mode gate_results by gate_id; count runs + distinct items; track latest ts +
// the outcome mix. A gate_id that the orchestrator had to reason through (instead of running a
// hardened script) is a candidate to codify into bin/.
// ---------------------------------------------------------------------------------------------
function reasoningGateCandidates(gateRows, registryByGate) {
  const byGate = new Map(); // gate_id -> aggregate
  for (const r of gateRows) {
    if (!r || typeof r !== 'object') continue;
    const isReasoning = lc(r.run_kind) === REASONING_RUN_KIND;
    const isCodifyPending = lc(r.outcome) === OUTCOME_CODIFY_PENDING;
    if (!isReasoning && !isCodifyPending) continue; // only reasoning-mode / codify-flagged rows
    const gateId = r.gate_id != null ? String(r.gate_id) : '(unnamed gate)';
    const cur = byGate.get(gateId) || {
      gate_id: gateId, runs: 0, items: new Set(), outcomes: new Map(), lastTs: null, codifyPending: false,
    };
    cur.runs += 1;
    if (r.item_id != null && r.item_id !== '') cur.items.add(String(r.item_id));
    const oc = lc(r.outcome) || '(none)';
    cur.outcomes.set(oc, (cur.outcomes.get(oc) || 0) + 1);
    if (isCodifyPending) cur.codifyPending = true;
    const ts = String(r.ts || '');
    if (!cur.lastTs || ts > cur.lastTs) cur.lastTs = ts || cur.lastTs;
    byGate.set(gateId, cur);
  }
  // Materialize + attach the registry-recorded run target (the proposed codification home).
  const list = [];
  for (const c of byGate.values()) {
    const reg = registryByGate.get(c.gate_id);
    // The registry `run` is the canonical target; if it's a *.sh path, we still propose the .mjs
    // hardened form there (the bin/ scripts are .mjs in this repo). If unregistered, derive a slug.
    const registeredRun = reg && reg.run ? String(reg.run) : null;
    const proposedScript = registeredRun || gateToBinSlug(c.gate_id);
    list.push({
      gate_id: c.gate_id,
      runs: c.runs,
      distinctItems: c.items.size,
      outcomes: Object.fromEntries([...c.outcomes.entries()].sort((a, b) => b[1] - a[1])),
      lastTs: c.lastTs || null,
      codifyPending: c.codifyPending,
      registered: !!reg,
      registeredRun,
      proposedScript,
      intent: reg && reg.intent ? reg.intent : null,
    });
  }
  // Rank by frequency (most-reasoned gates first — highest codification payoff), then recency.
  list.sort((a, b) => (b.runs - a.runs) || String(b.lastTs || '').localeCompare(String(a.lastTs || '')));
  return list;
}

// ---------------------------------------------------------------------------------------------
// Source 2: recurring failure patterns. Group the failures ledger by a normalized signature so the
// same class of failure recurring across items rises to the top. Signature = gate_id + a normalized
// cause/symptom family (we strip volatile bits: digits, hex shas, quoted strings, paths).
// ---------------------------------------------------------------------------------------------
function normalizeSignatureText(s) {
  return lc(s)
    .replace(/0x[0-9a-f]+/g, '<hex>')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
    .replace(/["'`][^"'`]*["'`]/g, '<str>')
    .replace(/[a-z]:[\\/][^\s]*/g, '<path>') // windows path
    .replace(/[\\/][^\s]*/g, '<path>')        // posix path
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

function recurringFailurePatterns(failureRows) {
  const bySig = new Map(); // signature -> aggregate
  for (const f of failureRows) {
    if (!f || typeof f !== 'object') continue;
    const gate = f.gate_id != null ? String(f.gate_id) : '(no gate)';
    const causeFamily = normalizeSignatureText(f.cause_hypothesis || f.symptom || '(unspecified)');
    const sig = `${gate} :: ${causeFamily || '(unspecified)'}`;
    const cur = bySig.get(sig) || {
      signature: sig, gate_id: gate, count: 0, items: new Set(), statuses: new Map(),
      examples: [], firstSeen: null, lastSeen: null, anyOpen: false,
    };
    cur.count += 1;
    if (f.item_id != null && f.item_id !== '') cur.items.add(String(f.item_id));
    const st = lc(f.status) || '(none)';
    cur.statuses.set(st, (cur.statuses.get(st) || 0) + 1);
    if (OPEN_FAILURE_STATUSES.has(st)) cur.anyOpen = true;
    if (cur.examples.length < 3) {
      const ex = f.symptom || f.cause_hypothesis || f.resolution || null;
      if (ex) cur.examples.push(truncate(ex, 160));
    }
    const fs = String(f.first_seen || f.ts || '');
    const ls = String(f.last_seen || f.ts || '');
    if (fs && (!cur.firstSeen || fs < cur.firstSeen)) cur.firstSeen = fs;
    if (ls && (!cur.lastSeen || ls > cur.lastSeen)) cur.lastSeen = ls;
    bySig.set(sig, cur);
  }
  const list = [];
  for (const c of bySig.values()) {
    list.push({
      signature: c.signature,
      gate_id: c.gate_id,
      count: c.count,
      distinctItems: c.items.size,
      statuses: Object.fromEntries([...c.statuses.entries()].sort((a, b) => b[1] - a[1])),
      examples: c.examples,
      firstSeen: c.firstSeen || null,
      lastSeen: c.lastSeen || null,
      anyOpen: c.anyOpen,
      recurring: c.count > 1, // "recurring" = seen more than once
    });
  }
  // Rank: recurring first, then by count desc, then still-open first, then recency.
  list.sort((a, b) =>
    (Number(b.recurring) - Number(a.recurring)) ||
    (b.count - a.count) ||
    (Number(b.anyOpen) - Number(a.anyOpen)) ||
    String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
  return list;
}

// ---------------------------------------------------------------------------------------------
// Source 3: surfaced orphans. G6 (and the detectors) SURFACE findings — they never auto-act
// (SCHEMA §4 G6). A surfaced finding is a gate_results row with outcome == "surfaced". We list each
// so the human can decide (the confer/work-item it implies).
// ---------------------------------------------------------------------------------------------
function surfacedOrphans(gateRows) {
  const list = [];
  for (const r of gateRows) {
    if (!r || typeof r !== 'object') continue;
    if (lc(r.outcome) !== OUTCOME_SURFACED) continue;
    list.push({
      gate_id: r.gate_id != null ? String(r.gate_id) : '(unnamed)',
      item_id: r.item_id != null ? String(r.item_id) : null,
      detail: typeof r.detail === 'string' ? r.detail : (r.detail ? JSON.stringify(r.detail) : null),
      run_kind: r.run_kind || null,
      ts: r.ts || null,
    });
  }
  // Newest surfaced first (most-recent sweep is most relevant).
  list.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  return list;
}

// ---------------------------------------------------------------------------------------------
// Render markdown
// ---------------------------------------------------------------------------------------------
function renderMarkdown({
  reasoningGates, failurePatterns, orphans, failureCatalogPath, registryPath,
  sources, commit, generatedAt, corruptNotes, isEmpty,
}) {
  const lines = [];
  lines.push('# Retro — latest');
  lines.push('');
  lines.push('> _Auto-generated by `bin/render-retro.mjs` at phase/plan completion (S-RETRO, SCHEMA §2 / §4). Source of truth: the `*.jsonl` ledger. Do not hand-edit._');
  lines.push('');
  lines.push(`- **generated:** ${generatedAt}${commit ? ` · commit \`${commit}\`` : ''}`);
  lines.push(`- **sources scanned:** gate_results=${sources.gate_results}, failures=${sources.failures}`);
  if (corruptNotes && corruptNotes.length) {
    lines.push(`- ⚠️ **ledger integrity:** ${corruptNotes.join('; ')}.`);
  }
  lines.push('');

  // Empty path — the spec's literal headline.
  if (isEmpty) {
    lines.push('## nothing to retro yet');
    lines.push('');
    lines.push('_No reasoning-mode gate runs, no recorded failures, and no surfaced orphans in the ledger. Once the orchestrator runs gates by reasoning (`run_kind: "orchestrator-reasoning"`), logs failures, or G6 surfaces orphans, this retro fills in with codification candidates, recurring-failure patterns, and the registry/bin additions they imply._');
    lines.push('');
    return lines.join('\n') + '\n';
  }

  // ---- Section 1: gates that ran on reasoning (codify candidates) ----------------------------
  lines.push('## 1. Gates that ran on reasoning — candidates to codify into `bin/`');
  lines.push('');
  if (reasoningGates.length === 0) {
    lines.push('_None — every gate this phase ran via its hardened `bin/` script (or no gate ran at all)._');
    lines.push('');
  } else {
    lines.push('_Each gate below was performed by orchestrator reasoning (`run_kind: "orchestrator-reasoning"`) rather than a hardened script. Per SCHEMA §4, a reasoning-mode gate is flagged for codification — hardening it into a `bin/` script makes it fast + deterministic. Ranked by how often it had to be reasoned (highest codification payoff first)._');
    lines.push('');
    lines.push('| Gate | Reasoned runs | Distinct items | Last run | Registered? | Proposed `bin/` target |');
    lines.push('|---|---:|---:|---|:---:|---|');
    for (const g of reasoningGates) {
      lines.push(
        `| ${escMd(g.gate_id)} | ${g.runs} | ${g.distinctItems} | ${escMd(g.lastTs || '—')} | ${g.registered ? 'yes' : 'no'} | \`${escMd(g.proposedScript)}\` |`,
      );
    }
    lines.push('');
  }

  // ---- Section 2: recurring failure patterns -------------------------------------------------
  lines.push('## 2. Recurring failure patterns');
  lines.push('');
  if (failurePatterns.length === 0) {
    lines.push('_No failures recorded in the ledger this phase._');
    lines.push('');
  } else {
    const recurring = failurePatterns.filter((p) => p.recurring);
    lines.push(`_Grouped by normalized signature (gate + cause family, volatile tokens masked). **${recurring.length}** signature(s) recurred (seen more than once); these are the highest-value targets for a failure-catalog entry + a regression guard._`);
    lines.push('');
    lines.push('| Signature | Occurrences | Items | Open? | Last seen |');
    lines.push('|---|---:|---:|:---:|---|');
    for (const p of failurePatterns) {
      lines.push(
        `| ${escMd(truncate(p.signature, 90))} | ${p.count}${p.recurring ? ' ⟲' : ''} | ${p.distinctItems} | ${p.anyOpen ? 'open' : '—'} | ${escMd(p.lastSeen || '—')} |`,
      );
    }
    lines.push('');
    // Examples for the recurring ones (kept out of the table to stay scannable).
    const withExamples = failurePatterns.filter((p) => p.recurring && p.examples.length);
    if (withExamples.length) {
      lines.push('<details><summary>Example symptoms for recurring signatures</summary>');
      lines.push('');
      for (const p of withExamples) {
        lines.push(`- **${escMd(truncate(p.signature, 90))}** (×${p.count}):`);
        for (const ex of p.examples) lines.push(`  - ${escMd(ex)}`);
      }
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  // ---- Section 3: surfaced orphans -----------------------------------------------------------
  lines.push('## 3. Surfaced orphans');
  lines.push('');
  if (orphans.length === 0) {
    lines.push('_No orphans surfaced (G6 / detectors recorded no `outcome: "surfaced"` rows). The sweep is clean._');
    lines.push('');
  } else {
    lines.push('_G6 + the detectors **surface** orphans — they never auto-act (SCHEMA §4 G6). Each row below is a confer/work-item the human should triage (wire it, remove it, or accept it)._');
    lines.push('');
    lines.push('| Detector / gate | Item | Detail |');
    lines.push('|---|---|---|');
    for (const o of orphans) {
      lines.push(`| ${escMd(o.gate_id)} | ${escMd(o.item_id || '—')} | ${escMd(truncate(o.detail || '—', 120))} |`);
    }
    lines.push('');
  }

  // ---- Section 4: proposed additions (grounded in 1-3) ---------------------------------------
  lines.push('## 4. Proposed registry / `bin/` additions');
  lines.push('');
  const proposals = [];
  for (const g of reasoningGates) {
    proposals.push(
      `**Codify gate \`${escMd(g.gate_id)}\`** → write \`${escMd(g.proposedScript)}\` (reasoned ${g.runs}× across ${g.distinctItems} item(s))${g.registered ? ' — the registry already points its `run` here; harden the reasoning into the script and it stops being reasoning-mode.' : ' — gate is **not** in `registry.json`; add a registry entry pointing `run` at this script, then implement it.'}`,
    );
  }
  for (const p of failurePatterns.filter((x) => x.recurring)) {
    proposals.push(
      `**Append to the failure catalog** (\`${escMd(failureCatalogPath || 'config.propagation.failures')}\`): the signature \`${escMd(truncate(p.signature, 80))}\` recurred ${p.count}×${p.anyOpen ? ' and is still open' : ''} — record the symptom, root cause, and a regression check so the debugger consults the catalog first next time (SCHEMA §2 S-DEBUG).`,
    );
  }
  if (orphans.length) {
    // Group surfaced orphans by their detector/gate so the proposal is per-class, not per-row.
    const byClass = new Map();
    for (const o of orphans) byClass.set(o.gate_id, (byClass.get(o.gate_id) || 0) + 1);
    for (const [cls, n] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) {
      proposals.push(
        `**Triage ${n} surfaced orphan(s) from \`${escMd(cls)}\`** → confer with the human to wire, remove, or accept each (G6 never auto-acts).`,
      );
    }
  }
  if (proposals.length === 0) {
    lines.push('_No concrete additions proposed — no reasoning-mode gates to codify, no recurring failures to catalog, no surfaced orphans to triage._');
    lines.push('');
  } else {
    proposals.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
    lines.push('');
    lines.push(`> Additions land in \`${escMd(registryPath)}\` (a new gate/detector/projection entry) and/or a new \`bin/\` script — **grow Valtor by adding a registry entry, never by editing the state machine** (SCHEMA §2).`);
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------
function main() {
  // Config is the per-repo seam, but the renderer must still produce a valid artifact on a fresh
  // repo. readConfigSafe() returns {} (→ defaults) instead of exiting the process.
  const cfg = readConfigSafe();

  // Where the failure catalog lives (config.propagation.failures) — surfaced in proposals; the
  // renderer does NOT write it (orchestrator G7 does). Degrades to a sensible default note.
  const failureCatalogPath = cfg && cfg.propagation && cfg.propagation.failures
    ? String(cfg.propagation.failures)
    : null;
  const registryPath = `${String(HOME).replace(/[/\\]+$/, '')}/registry.json`;

  // Registry gate → run-target map (enriches codification proposals). Defensive (absent/corrupt → empty).
  const registryByGate = readRegistryGateRuns();

  // Survey the two source ledgers defensively. Both degrade to [] when missing/empty/corrupt.
  const gatesSurvey = surveyTable('gate_results');
  const failuresSurvey = surveyTable('failures');

  const gateRows = gatesSurvey.rows;
  const failureRows = failuresSurvey.rows;

  const corruptNotes = [];
  if (gatesSurvey.corruptLines.length) corruptNotes.push(`gate_results.jsonl: ${gatesSurvey.corruptLines.length} corrupt line(s) skipped`);
  if (failuresSurvey.corruptLines.length) corruptNotes.push(`failures.jsonl: ${failuresSurvey.corruptLines.length} corrupt line(s) skipped`);

  const reasoningGates = reasoningGateCandidates(gateRows, registryByGate);
  const failurePatterns = recurringFailurePatterns(failureRows);
  const orphans = surfacedOrphans(gateRows);

  const isEmpty = reasoningGates.length === 0 && failurePatterns.length === 0 && orphans.length === 0;

  // Best-effort current commit for provenance. git-absent → omit (graceful degradation).
  const head = tryGit('rev-parse --short HEAD');
  const commit = head && head.ok && head.out ? head.out : null;

  const generatedAt = nowIso();
  const md = renderMarkdown({
    reasoningGates,
    failurePatterns,
    orphans,
    failureCatalogPath,
    registryPath,
    sources: { gate_results: gateRows.length, failures: failureRows.length },
    commit,
    generatedAt,
    corruptNotes,
    isEmpty,
  });

  // Write the single 'out' artifact: HOME/retro-latest.md. A write failure is REPORTED (not thrown)
  // and we still exit 0 — a renderer never blocks the loop.
  const outPath = join(HOME, 'retro-latest.md');
  let written = false;
  let writeError = null;
  try {
    const dir = dirname(outPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(outPath, md);
    written = true;
  } catch (e) {
    writeError = e && e.message ? e.message : String(e);
  }

  out({
    ok: true,
    out: outPath,
    written,
    ...(writeError ? { writeError } : {}),
    empty: isEmpty,
    counts: {
      reasoningGates: reasoningGates.length,
      recurringFailureSignatures: failurePatterns.filter((p) => p.recurring).length,
      failureSignatures: failurePatterns.length,
      surfacedOrphans: orphans.length,
    },
    sources: { gate_results: gateRows.length, failures: failureRows.length },
    ...(corruptNotes.length ? { integrityNotes: corruptNotes } : {}),
    bytes: Buffer.byteLength(md),
  });
  process.exit(0);
}

try {
  main();
} catch (e) {
  // Last-resort guard: the hard rules forbid an unhandled stack trace, and a renderer never blocks.
  // Emit clean JSON and exit 0 (report-only).
  out({ ok: true, written: false, error: `render-retro degraded: ${e && e.message ? e.message : String(e)}` });
  process.exit(0);
}
