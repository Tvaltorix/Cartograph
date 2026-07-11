#!/usr/bin/env node
// render-readiness.mjs — projection 'readiness' (registry.json) → HOME/READINESS.md.
//
//   node render-readiness.mjs
//
// Computes config.readinessModel.dimensions (default: BUILD, TEST, INTEGRATION, DEPLOY,
// DEMO-READY, SECURITY-CLEAR), each scored 0–100 from the `items` + `gate_results` ledgers,
// per SCHEMA §10. overall = the aggregator named by config.readinessModel.overall ("min" by
// default — a project is only as ready as its weakest dimension; min(), NOT mean()).
//
// RENDERER CONTRACT (registry projection):
//   * Writes ONLY its single 'out' artifact (HOME/READINESS.md). Touches nothing else in the tree.
//   * Reports, never blocks: ALWAYS exit 0 (even on an empty ledger or a write hiccup it reports).
//   * Reads every repo-specific value from loadConfig(); nothing repo-specific is hardcoded.
//
// GRACEFUL DEGRADATION (the headline requirement):
//   * Empty ledger / no matching rows / missing config key / git-absent → every dimension scores
//     0 or N/A, a VALID READINESS.md is still written, exit 0. Never a stack trace.
//
// Scoring (SCHEMA §10 — "is it built / tested / deployed?"):
//   BUILD          = items integrated (status done/closed) / total in-scope items
//   TEST           = G4 + GV pass rate over their gate_results
//   INTEGRATION    = G4c + G-E2E pass rate
//   DEPLOY         = G5 (smoke + neg-authz) + G5.5 (deploy-health) green rate
//   DEMO-READY     = demo_path items done  (E2E green folded in when any E2E result exists)
//   SECURITY-CLEAR = G2 + negative-authz pass rate, zeroed out if ANY open security veto exists
// One honest denominator (SCHEMA §10): total = sum of all statuses; out_of_scope excluded from
// the denominator and listed separately; deferred stays in the denominator.

// We deliberately do NOT import lib's loadConfig()/readRows(): both call lib.fail() →
// process.exit(1) on a missing/corrupt config or a single corrupt jsonl row, which a try/catch
// CANNOT trap (it's a process exit, not a throw). A renderer must degrade gracefully — still write
// a valid artifact and exit 0 — so we read the config + ledgers with local defensive readers
// (the same reason index-rebuild.mjs avoids readRows()). INDEX/HOME/nowIso/tryGit/out are pure.
import { INDEX, HOME, CONFIG_PATH, nowIso, tryGit, out } from './lib.mjs';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// Defensive config read — returns {} on absent/corrupt config instead of exiting the process.
function readConfigSafe() {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch {
    return {}; // corrupt config → fall back to defaults, still render
  }
}

// Defensive ledger read — returns parsed rows, SKIPPING any line that fails to parse (never exits,
// never throws). Absent/empty file → []. Mirrors index-rebuild.mjs's surveyTable() tolerance.
function readRowsSafe(table) {
  try {
    const p = join(INDEX, `${table}.jsonl`);
    if (!existsSync(p)) return [];
    const rows = [];
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { rows.push(JSON.parse(s)); } catch { /* skip corrupt row, keep going */ }
    }
    return rows;
  } catch {
    return [];
  }
}

// ---- defaults (used only when the config key is absent — graceful degradation) ----------------
const DEFAULT_DIMENSIONS = ['BUILD', 'TEST', 'INTEGRATION', 'DEPLOY', 'DEMO-READY', 'SECURITY-CLEAR'];
const DEFAULT_OVERALL = 'min';

// Item statuses (SCHEMA §3 LoopItem.status). "Integrated/built" = it reached a terminal-done state.
const DONE_STATUSES = new Set(['done', 'closed']);
const OUT_OF_SCOPE_STATUS = 'superseded'; // surfaced separately, not in the denominator
const ORPHAN_STATUSES = new Set(['orphan', 'stale']);

// gate_results.outcome values (SCHEMA §3.1). Only pass/fail move a rate; the rest are neutral.
const PASS = 'pass';
const FAIL = 'fail';
const HALT = 'halt';

// Map each dimension to the gate ids that feed it. Gate ids are stable across repos (defined in
// the universal registry.json / SCHEMA §4), so this mapping is part of the *mechanism*, not a
// per-repo value. Prefix-matched so "G5" also catches "G5-smoke" / "G5-negative-authz".
const DIMENSION_GATES = {
  TEST: ['G4', 'GV'],
  INTEGRATION: ['G4c', 'G-E2E', 'G-e2e'],
  DEPLOY: ['G5', 'G5.5'],
  'SECURITY-CLEAR': ['G2', 'negative-authz', 'neg-authz'],
};

// ---- small helpers ----------------------------------------------------------------------------

function pct(numer, denom) {
  if (!denom || denom <= 0) return null; // N/A — no signal yet
  return Math.round((numer / denom) * 100);
}

// A gate_results row matches a dimension if its gate_id matches one of the dimension's gate keys
// (case-insensitive) on a TOKEN BOUNDARY: the id either equals the key, or the character right after
// the key is a non-alphanumeric separator (- . _ / space). This is deliberately NOT a raw startsWith:
//   * key "G4" matches "G4-test-gap"      (next char '-' is a separator)   ✓ TEST
//   * key "G4" must NOT match "G4c-…"/"G4b-…" (next char is alnum)         → G4c belongs to INTEGRATION,
//                                                                            G4b to code-review, not TEST.
//   * key "G2" must NOT match "G2b-ready" (next char is alnum)            → G2b is PM Definition-of-Ready.
//   * key "G5" still matches "G5.5-deploy-health" (next char '.' is a sep) ✓ DEPLOY keeps G5.5.
// Naive startsWith leaked G4c into TEST (inflating its pass rate) — this boundary check fixes that.
function gateMatches(gateId, keys) {
  const g = String(gateId || '').toLowerCase();
  return (keys || []).some((kRaw) => {
    const k = String(kRaw).toLowerCase();
    if (!k) return false;
    if (g === k) return true;
    if (!g.startsWith(k)) return false;
    const next = g.charAt(k.length); // char right after the matched key
    return !/[a-z0-9]/.test(next);    // boundary only on a non-alphanumeric separator
  });
}

// Compute a pass-rate over the gate_results whose gate_id matches `keys`. We score the LATEST
// outcome per (item_id, gate_id) pair so a fixed-after-fail item counts once as its final state,
// not twice. Rows are appended in time order, so the last seen wins. Returns
// { score:0-100|null, pass, fail, total, anyOpenHalt }.
function gateRate(gateRows, keys) {
  const latest = new Map(); // key -> { outcome, hasHalt }
  let anyOpenHalt = false;
  for (const r of gateRows) {
    if (!r) continue;
    if (!gateMatches(r.gate_id, keys)) continue;
    const outcome = String(r.outcome || '').toLowerCase();
    if (outcome === HALT) anyOpenHalt = true;
    const k = `${r.item_id ?? ''}::${r.gate_id ?? ''}`;
    // Track a per-pair halt too; a pair whose final outcome is a halt is unresolved.
    const prev = latest.get(k) || { outcome: null, hasHalt: false };
    latest.set(k, { outcome, hasHalt: prev.hasHalt || outcome === HALT });
  }
  let pass = 0;
  let fail = 0;
  for (const v of latest.values()) {
    if (v.outcome === PASS) pass += 1;
    else if (v.outcome === FAIL || v.outcome === HALT) fail += 1;
    // pass/fail only move the rate; 'surfaced' / 'skipped-codify-pending' are neutral (excluded)
  }
  const total = pass + fail;
  return { score: pct(pass, total), pass, fail, total, anyOpenHalt };
}

// ---- dimension scorers ------------------------------------------------------------------------

// BUILD: integrated / total-in-scope. The honest denominator = every item that is NOT out_of_scope.
// deferred stays in the denominator (SCHEMA §10). out_of_scope items are surfaced separately.
function scoreBuild(items) {
  const inScope = items.filter((i) => i && !i.out_of_scope && i.status !== OUT_OF_SCOPE_STATUS);
  const integrated = inScope.filter((i) => DONE_STATUSES.has(String(i.status || '').toLowerCase()));
  return {
    score: pct(integrated.length, inScope.length),
    detail: { integrated: integrated.length, inScope: inScope.length },
  };
}

// DEMO-READY: of the demo_path items, how many are done. E2E green is folded in when any E2E
// result exists — a declared flow must be green for demo-done (SCHEMA §7, §10). If no demo_path
// items exist, the dimension is N/A (not 0 — there is simply no demo surface declared yet).
function scoreDemoReady(items, gateRows) {
  const demoItems = items.filter((i) => i && i.demo_path === true && !i.out_of_scope);
  const demoScore = demoItems.length
    ? pct(demoItems.filter((i) => DONE_STATUSES.has(String(i.status || '').toLowerCase())).length, demoItems.length)
    : null;
  // E2E gate (G-E2E) green rate, only counted if any E2E result has been recorded.
  const e2e = gateRate(gateRows, ['G-E2E', 'G-e2e']);
  let score = demoScore;
  if (demoScore !== null && e2e.total > 0 && e2e.score !== null) {
    score = Math.round((demoScore + e2e.score) / 2); // both must be high for demo-readiness
  }
  return {
    score,
    detail: {
      demoItems: demoItems.length,
      demoDone: demoItems.filter((i) => DONE_STATUSES.has(String(i.status || '').toLowerCase())).length,
      e2eGreenRate: e2e.total > 0 ? e2e.score : null,
    },
  };
}

// SECURITY-CLEAR: G2 + negative-authz pass rate, hard-zeroed if ANY open security veto exists.
// Open veto signal sources (any one trips it): a G2 gate_result with outcome halt that has no
// later pass for the same (item,gate); a halt-case-5 (security veto) decision still un-graduated;
// or an item in 'question'/'orphan' status flagged by a security gate. We use the gate ledger's
// per-pair halt tracking as the structural signal — it requires no extra ledger we may not have.
function scoreSecurity(gateRows, securityHalts) {
  const rate = gateRate(gateRows, DIMENSION_GATES['SECURITY-CLEAR']);
  const openVeto = rate.anyOpenHalt || securityHalts > 0;
  return {
    score: openVeto ? 0 : rate.score,
    detail: { pass: rate.pass, fail: rate.fail, total: rate.total, openVeto },
  };
}

// ---- text gauge -------------------------------------------------------------------------------
// A 20-cell bar. null score → "N/A" with an empty track (no signal yet).
function gauge(score) {
  const width = 20;
  if (score === null || score === undefined) {
    return `[${'·'.repeat(width)}]  N/A`;
  }
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const filled = Math.round((clamped / 100) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `[${bar}] ${String(clamped).padStart(3, ' ')}%`;
}

// overall aggregator. Only "min" is specified by SCHEMA §10; we honor whatever the config names,
// falling back to min for anything unrecognized (the safe, schema-aligned default). N/A dimensions
// are EXCLUDED from the aggregate (an unmeasured dimension shouldn't drag the floor to 0); if every
// dimension is N/A the overall is N/A too.
function aggregate(scores, mode) {
  const present = scores.filter((s) => s !== null && s !== undefined);
  if (present.length === 0) return null;
  const m = String(mode || DEFAULT_OVERALL).toLowerCase();
  if (m === 'mean' || m === 'avg' || m === 'average') {
    return Math.round(present.reduce((a, b) => a + b, 0) / present.length);
  }
  if (m === 'max') return Math.max(...present);
  // default + explicit "min": a project is only as ready as its weakest measured dimension.
  return Math.min(...present);
}

// ---- render -----------------------------------------------------------------------------------

function renderMarkdown({ dimensions, dimScores, dimDetail, overall, overallMode, counts, commit, generatedAt }) {
  const lines = [];
  lines.push('# Readiness');
  lines.push('');
  lines.push(`_Generated ${generatedAt}${commit ? ` · commit \`${commit}\`` : ''} · overall = \`${overallMode}()\` of measured dimensions (SCHEMA §10)._`);
  lines.push('');

  // Overall gauge up top.
  lines.push('## Overall');
  lines.push('');
  lines.push('```');
  lines.push(`OVERALL        ${gauge(overall)}`);
  lines.push('```');
  if (overall === null) {
    lines.push('');
    lines.push('> No measurable signal yet — empty ledger or no gate results recorded. Every dimension is N/A until items + gate_results land.');
  } else {
    lines.push('');
    lines.push(`> Overall is the **${overallMode}()** of the measured dimensions — a project is only as ready as its weakest dimension. N/A dimensions are excluded from the aggregate.`);
  }
  lines.push('');

  // Per-dimension gauges.
  lines.push('## Dimensions');
  lines.push('');
  lines.push('```');
  const labelWidth = Math.max(...dimensions.map((d) => d.length), 'OVERALL'.length);
  for (const d of dimensions) {
    lines.push(`${d.padEnd(labelWidth, ' ')}  ${gauge(dimScores[d])}`);
  }
  lines.push('```');
  lines.push('');

  // Detail table — what fed each score.
  lines.push('## How each dimension is scored');
  lines.push('');
  lines.push('| Dimension | Score | Basis | Detail |');
  lines.push('|---|---|---|---|');
  const basis = {
    BUILD: 'items integrated / total in-scope',
    TEST: 'G4 + GV pass rate',
    INTEGRATION: 'G4c + E2E pass rate',
    DEPLOY: 'G5 + G5.5 green rate',
    'DEMO-READY': 'demo_path items done (+ E2E green)',
    'SECURITY-CLEAR': 'G2 + negative-authz, 0 open vetoes',
  };
  for (const d of dimensions) {
    const s = dimScores[d];
    const scoreCell = s === null || s === undefined ? 'N/A' : `${s}%`;
    const det = dimDetail[d] ? '`' + JSON.stringify(dimDetail[d]) + '`' : '—';
    lines.push(`| ${d} | ${scoreCell} | ${basis[d] || 'gate pass rate'} | ${det} |`);
  }
  lines.push('');

  // Honest denominator block (SCHEMA §10).
  lines.push('## Item denominator (honest count)');
  lines.push('');
  lines.push('| Bucket | Count |');
  lines.push('|---|---|');
  lines.push(`| In-scope total (the BUILD denominator) | ${counts.inScope} |`);
  lines.push(`| └ integrated (done/closed) | ${counts.integrated} |`);
  lines.push(`| └ deferred (stays in denominator) | ${counts.deferred} |`);
  lines.push(`| └ open / in_progress / debugging | ${counts.active} |`);
  lines.push(`| └ question / orphan / stale | ${counts.flagged} |`);
  lines.push(`| out_of_scope (excluded, listed separately) | ${counts.outOfScope} |`);
  lines.push(`| **All statuses (grand total)** | **${counts.grandTotal}** |`);
  lines.push('');
  lines.push('> `out_of_scope` items are excluded from the BUILD denominator; `deferred` items stay in it (SCHEMA §10). No silent truncation — the % never lies.');
  lines.push('');

  return lines.join('\n') + '\n';
}

// ---- main -------------------------------------------------------------------------------------

function main() {
  // A renderer must ALWAYS write a valid artifact and exit 0 — even with a missing or corrupt
  // config seam. readConfigSafe() returns {} (→ defaults) instead of exiting the process.
  const cfg = readConfigSafe();

  const model = (cfg && cfg.readinessModel) || {};
  const dimensions = Array.isArray(model.dimensions) && model.dimensions.length
    ? model.dimensions.map(String)
    : DEFAULT_DIMENSIONS.slice();
  const overallMode = model.overall ? String(model.overall) : DEFAULT_OVERALL;

  // Read the source ledgers defensively. readRowsSafe() returns [] for an absent/empty file and
  // skips any corrupt row (it never exits the process — unlike lib.readRows()).
  const items = readRowsSafe('items');
  const gateRows = readRowsSafe('gate_results');
  const decisions = readRowsSafe('decisions');

  // Honest item counts (SCHEMA §10).
  const lc = (s) => String(s || '').toLowerCase();
  const outOfScopeItems = items.filter((i) => i && (i.out_of_scope === true || lc(i.status) === OUT_OF_SCOPE_STATUS));
  const inScopeItems = items.filter((i) => i && !(i.out_of_scope === true || lc(i.status) === OUT_OF_SCOPE_STATUS));
  const integrated = inScopeItems.filter((i) => DONE_STATUSES.has(lc(i.status)));
  const deferred = inScopeItems.filter((i) => lc(i.status) === 'deferred');
  const active = inScopeItems.filter((i) => ['open', 'in_progress', 'debugging'].includes(lc(i.status)));
  const flagged = inScopeItems.filter((i) => lc(i.status) === 'question' || ORPHAN_STATUSES.has(lc(i.status)));

  const counts = {
    grandTotal: items.length,
    inScope: inScopeItems.length,
    integrated: integrated.length,
    deferred: deferred.length,
    active: active.length,
    flagged: flagged.length,
    outOfScope: outOfScopeItems.length,
  };

  // Count open security vetoes (halt-case-5 decisions that never graduated). Defensive: the
  // decisions ledger may be empty or shaped differently across repos.
  const securityHalts = decisions.filter((d) => {
    if (!d) return false;
    const isVetoCase = String(d.halt_case || '') === '5';
    const ungraduated = !d.graduated_to || lc(d.graduated_to) === 'null';
    const unanswered = d.answer == null || String(d.answer).trim() === '';
    return isVetoCase && (unanswered || ungraduated === false ? unanswered : false);
  }).length;

  // Score each dimension. Unknown dimensions (a repo could rename them) fall back to a generic
  // gate pass-rate using DIMENSION_GATES if mapped, else N/A — never throw.
  const dimScores = {};
  const dimDetail = {};
  for (const d of dimensions) {
    if (d === 'BUILD') {
      const r = scoreBuild(items);
      dimScores[d] = r.score;
      dimDetail[d] = r.detail;
    } else if (d === 'DEMO-READY') {
      const r = scoreDemoReady(items, gateRows);
      dimScores[d] = r.score;
      dimDetail[d] = r.detail;
    } else if (d === 'SECURITY-CLEAR') {
      const r = scoreSecurity(gateRows, securityHalts);
      dimScores[d] = r.score;
      dimDetail[d] = r.detail;
    } else if (DIMENSION_GATES[d]) {
      const r = gateRate(gateRows, DIMENSION_GATES[d]);
      dimScores[d] = r.score;
      dimDetail[d] = { pass: r.pass, fail: r.fail, total: r.total };
    } else {
      // Unrecognized dimension name from a repo-custom config — no mapping, no signal.
      dimScores[d] = null;
      dimDetail[d] = { note: 'no gate mapping for this dimension' };
    }
  }

  const overall = aggregate(dimensions.map((d) => dimScores[d]), overallMode);

  // Best-effort current commit for provenance. git-absent → omit (graceful degradation).
  const head = tryGit('rev-parse --short HEAD');
  const commit = head && head.ok ? head.out : null;

  const generatedAt = nowIso();
  const md = renderMarkdown({
    dimensions, dimScores, dimDetail, overall, overallMode, counts, commit, generatedAt,
  });

  // Write the single 'out' artifact: HOME/READINESS.md. Ensure HOME exists. A write failure is
  // REPORTED (not thrown) and we still exit 0 — a renderer never blocks the loop.
  const outPath = join(HOME, 'READINESS.md');
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

  // Renderers report, never block: ALWAYS exit 0. We emit JSON directly (not lib.ok(), which
  // would also exit 0, but we want the explicit shape + a possible writeError field).
  out({
    ok: true,
    out: outPath,
    written,
    ...(writeError ? { writeError } : {}),
    overall,
    overallMode,
    dimensions: dimScores,
    counts,
    sources: { items: items.length, gate_results: gateRows.length, decisions: decisions.length },
  });
  process.exit(0);
}

try {
  main();
} catch (e) {
  // Last-resort guard: the hard rules forbid an unhandled stack trace, and a renderer never blocks.
  // Emit clean JSON and exit 0 (report-only).
  out({ ok: true, written: false, error: `render-readiness degraded: ${e && e.message ? e.message : String(e)}` });
  process.exit(0);
}
