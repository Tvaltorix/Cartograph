#!/usr/bin/env node
// render-blockers.mjs — projection 'blockers' (registry.json) → HOME/BLOCKERS.md.
//
//   node render-blockers.mjs
//
// Builds ONE blocker register from FIVE computable ledger sources (SCHEMA §3.1, §6, §10) and
// writes the single 'out' artifact HOME/BLOCKERS.md. It ALSO notes that the orchestrator should
// sync the same content to config.propagation.stateDir/05-risks-and-blockers.md (we surface that
// target path in the JSON result + a header line in the file; a renderer writes only its own
// artifact, so we do NOT write the stateDir copy here — the orchestrator's G7 propagate step does).
//
// RENDERER CONTRACT (registry projection):
//   * Writes ONLY its single 'out' artifact (HOME/BLOCKERS.md). Touches nothing else in the tree.
//   * Reports, never blocks: ALWAYS exit 0 (even on an empty ledger or a write hiccup it reports).
//   * Reads every repo-specific value from loadConfig(); nothing repo-specific is hardcoded.
//
// GRACEFUL DEGRADATION (the headline requirement):
//   * Empty ledger / no matching rows / missing config key / git-absent → a VALID "no blockers"
//     BLOCKERS.md is still written, exit 0. Never a stack trace.
//
// The five sources (each row carries `source` so the register is auditable):
//   1. status==question                — an item parked on a human decision (S-ASK).
//   2. open gate fail/halt             — a gate_results row whose outcome is fail|halt with NO
//                                        later pass for the same (item_id, gate_id) pair.
//   3. security veto                   — an open fail/halt on a security-owned gate (G2 / neg-authz),
//                                        OR an un-resolved halt_case=5 decision (SCHEMA §6 case 5).
//   4. missing-decision                — a question-status item with NO decisions-ledger row at all.
//   5. dependency-blocked              — an item with depends_on → a target item that is not
//                                        done/deferred (the subtree root is incomplete).
//
// Per blocker (SCHEMA §10 + the spec):
//   * severity = P0 if it blocks a demo_path item OR is a security veto;
//               P1 if it blocks any non-deferred item;
//               else P2.
//   * age_hours = now - first_seen   (first_seen falls back to the row's `ts`; null if unknown).

// We deliberately do NOT import lib's loadConfig(): it calls lib.fail() → process.exit(1) on a
// missing/corrupt config, which a try/catch CANNOT trap (it's a process exit, not a throw). A
// renderer must degrade gracefully — still write a valid artifact and exit 0 — so we read the
// config with a local defensive reader (same rationale as render-readiness.mjs). This is THE
// fresh-repo portability case: no valtor.config.json present yet. INDEX/HOME/CONFIG_PATH/nowIso/
// tryGit/out are pure and safe to import.
import { HOME, INDEX, CONFIG_PATH, tryGit, nowIso, out } from './lib.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// Local table-path resolver (avoids importing lib.tablePath so the import surface stays minimal +
// purely-safe). Mirrors lib.tablePath: INDEX/<table>.jsonl, honoring $VALTOR_HOME via INDEX.
function tablePathSafe(table) {
  return join(INDEX, `${table}.jsonl`);
}

// ---------------------------------------------------------------------------------------------
// Status model (SCHEMA §3 LoopItem.status).
// ---------------------------------------------------------------------------------------------
const DONE_STATUSES = new Set(['done', 'closed']);
// "Settled" = an item that no longer blocks anything downstream (its dependents may proceed).
const SETTLED_STATUSES = new Set(['done', 'closed', 'deferred', 'superseded']);
// gate_results.outcome values that are a blocking condition while still open (SCHEMA §3.1).
const OPEN_FAIL_OUTCOMES = new Set(['fail', 'halt']);
const PASS = 'pass';

// Security-owned gate ids (SCHEMA §4 — owner == security). Substring/prefix matched so
// "G2-arch-security-scope" and "G5-negative-authz" both trip it. Gate ids are part of the
// universal mechanism (registry.json), not a per-repo value, so this list lives in code.
const SECURITY_GATE_KEYS = ['g2', 'negative-authz', 'neg-authz', 'security', 'veto'];
const SECURITY_VETO_HALT_CASE = '5'; // SCHEMA §6 case 5 = security veto.

// ---------------------------------------------------------------------------------------------
// Defensive jsonl reader (mirrors render-board.mjs): survey every line, skip + count corrupt ones,
// never throw, never mutate the file. Returns { rows, corruptLines, missing }.
// ---------------------------------------------------------------------------------------------
function surveyTable(table) {
  let p;
  try { p = tablePathSafe(table); } catch { return { rows: [], corruptLines: [], missing: true }; }
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

function ageHours(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.round(((Date.now() - t) / 36e5) * 10) / 10; // one decimal
}

function escMd(s) {
  // Keep Markdown table cells from breaking on a literal pipe or newline.
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function isSecurityGate(gateId) {
  const g = lc(gateId);
  return SECURITY_GATE_KEYS.some((k) => g.includes(k));
}

// ---------------------------------------------------------------------------------------------
// Index helpers over the items ledger.
// ---------------------------------------------------------------------------------------------
function indexItems(items) {
  const byId = new Map(); // id -> item (last write wins; ledger is append-order)
  for (const it of items) {
    if (!it || it.id == null) continue;
    byId.set(String(it.id), it);
  }
  return byId;
}

// Does this item (by id) block a demo_path item? An item blocks a demo item if it IS a demo_path
// item, or if any demo_path item depends_on it (directly). Direct-edge check keeps it bounded +
// truthful (the full transitive closure lives in the dependency graph; one hop is the honest,
// cheap signal for severity).
function blocksDemo(itemId, item, items) {
  if (item && item.demo_path === true) return true;
  if (itemId == null) return false;
  const id = String(itemId);
  return items.some((other) => {
    if (!other || other.demo_path !== true) return false;
    const deps = Array.isArray(other.depends_on) ? other.depends_on.map(String) : [];
    return deps.includes(id);
  });
}

// Does this item block any NON-deferred item (including itself, if it's non-deferred + not done)?
// Used for the P1 rung.
function blocksNonDeferred(itemId, item, items) {
  // The item itself, if it's not settled (done/deferred/etc.), is a live non-deferred blocker.
  if (item && !SETTLED_STATUSES.has(lc(item.status))) return true;
  if (itemId == null) return false;
  const id = String(itemId);
  return items.some((other) => {
    if (!other) return false;
    const deps = Array.isArray(other.depends_on) ? other.depends_on.map(String) : [];
    if (!deps.includes(id)) return false;
    return lc(other.status) !== 'deferred'; // a dependent that isn't itself deferred
  });
}

// Compute severity for a blocker per the spec:
//   P0 if it blocks a demo_path item OR is a security veto;
//   P1 if it blocks any non-deferred item;
//   else P2.
function computeSeverity({ isSecurityVeto, itemId, item, items }) {
  if (isSecurityVeto) return 'P0';
  if (blocksDemo(itemId, item, items)) return 'P0';
  if (blocksNonDeferred(itemId, item, items)) return 'P1';
  return 'P2';
}

// ---------------------------------------------------------------------------------------------
// Source 2 + 3: open gate fail/halt. Compute the LATEST outcome per (item_id, gate_id) pair (rows
// are appended in time order; last seen wins). A pair is an OPEN blocker if its final outcome is
// fail|halt with no later pass. Returns an array of { item_id, gate_id, outcome, ts, securityGate }.
// ---------------------------------------------------------------------------------------------
function openGateBlockers(gateRows) {
  const latest = new Map(); // key -> row (the chronologically last row for the pair)
  for (const r of gateRows) {
    if (!r || typeof r !== 'object') continue;
    const key = `${r.item_id ?? ''}::${r.gate_id ?? ''}`;
    const prev = latest.get(key);
    if (!prev) { latest.set(key, r); continue; }
    // Prefer the later ts; if ts is missing/equal, keep append-order (the new row wins).
    const a = String(r.ts || '');
    const b = String(prev.ts || '');
    if (a >= b) latest.set(key, r);
  }
  const open = [];
  for (const r of latest.values()) {
    const outcome = lc(r.outcome);
    if (outcome === PASS) continue; // resolved — final state is a pass
    if (!OPEN_FAIL_OUTCOMES.has(outcome)) continue; // surfaced/skipped/etc. are not blockers
    open.push({
      item_id: r.item_id ?? null,
      gate_id: r.gate_id ?? null,
      outcome,
      ts: r.ts || null,
      detail: r.detail || null,
      securityGate: isSecurityGate(r.gate_id),
    });
  }
  return open;
}

// ---------------------------------------------------------------------------------------------
// Source 3 (decision arm): un-resolved security-veto decisions (halt_case == 5 with no answer).
// SCHEMA §3.1 decisions: { halt_case, answer, answered_at, ... }. An unanswered veto is open.
// ---------------------------------------------------------------------------------------------
function openSecurityVetoDecisions(decisions) {
  return decisions.filter((d) => {
    if (!d) return false;
    if (String(d.halt_case || '') !== SECURITY_VETO_HALT_CASE) return false;
    const answered = d.answer != null && String(d.answer).trim() !== '';
    return !answered; // unresolved veto
  });
}

// ---------------------------------------------------------------------------------------------
// Source 4: missing-decision — a question-status item with NO decisions row referencing it.
// ---------------------------------------------------------------------------------------------
function decisionItemIds(decisions) {
  const ids = new Set();
  for (const d of decisions) {
    if (d && d.item_id != null && d.item_id !== '') ids.add(String(d.item_id));
  }
  return ids;
}

// ---------------------------------------------------------------------------------------------
// Build the unified blocker register from all five sources.
// ---------------------------------------------------------------------------------------------
function buildBlockers({ items, gateRows, decisions }) {
  const byId = indexItems(items);
  const decided = decisionItemIds(decisions);
  const blockers = [];

  // ---- Source 1: status == question ----------------------------------------------------------
  for (const it of items) {
    if (!it || lc(it.status) !== 'question') continue;
    const itemId = it.id != null ? String(it.id) : null;
    const seen = it.first_seen || it.ts || null;
    const severity = computeSeverity({ isSecurityVeto: false, itemId, item: it, items });
    blockers.push({
      source: 'status-question',
      item_id: itemId,
      gate_id: null,
      severity,
      age_hours: ageHours(seen),
      first_seen: seen,
      reason: 'item parked on a human decision (status=question)',
      detail: it.goal || it.text || null,
    });
  }

  // ---- Source 2 + 3 (gate arm): open gate fail/halt ------------------------------------------
  for (const g of openGateBlockers(gateRows)) {
    const itemId = g.item_id != null ? String(g.item_id) : null;
    const item = itemId != null ? byId.get(itemId) : null;
    const isSecurityVeto = g.outcome === 'halt' && g.securityGate; // a security-owned halt is a veto
    const seen = g.ts || (item && (item.first_seen || item.ts)) || null;
    const severity = computeSeverity({ isSecurityVeto, itemId, item, items });
    blockers.push({
      source: isSecurityVeto ? 'security-veto' : 'gate-fail',
      item_id: itemId,
      gate_id: g.gate_id,
      severity,
      age_hours: ageHours(seen),
      first_seen: seen,
      reason: `${g.gate_id || 'gate'} outcome=${g.outcome}${g.securityGate ? ' (security-owned)' : ''} still open`,
      detail: typeof g.detail === 'string' ? g.detail : (g.detail ? JSON.stringify(g.detail) : null),
    });
  }

  // ---- Source 3 (decision arm): un-resolved security-veto decisions --------------------------
  for (const d of openSecurityVetoDecisions(decisions)) {
    const itemId = d.item_id != null ? String(d.item_id) : null;
    const item = itemId != null ? byId.get(itemId) : null;
    const seen = d.first_seen || d.answered_at || d.ts || null;
    const severity = computeSeverity({ isSecurityVeto: true, itemId, item, items });
    blockers.push({
      source: 'security-veto',
      item_id: itemId,
      gate_id: 'decision:halt_case=5',
      severity, // always P0 (security veto)
      age_hours: ageHours(seen),
      first_seen: seen,
      reason: 'security veto (halt_case=5) decision is unresolved',
      detail: d.question || null,
    });
  }

  // ---- Source 4: missing-decision (question item with no decisions row) ----------------------
  for (const it of items) {
    if (!it || lc(it.status) !== 'question') continue;
    const itemId = it.id != null ? String(it.id) : null;
    if (itemId != null && decided.has(itemId)) continue; // it HAS a decision row → not missing
    const seen = it.first_seen || it.ts || null;
    const severity = computeSeverity({ isSecurityVeto: false, itemId, item: it, items });
    blockers.push({
      source: 'missing-decision',
      item_id: itemId,
      gate_id: null,
      severity,
      age_hours: ageHours(seen),
      first_seen: seen,
      reason: 'question item has no decisions-ledger row (the fork was never posed/recorded)',
      detail: it.goal || it.text || null,
    });
  }

  // ---- Source 5: dependency-blocked (depends_on → an unsettled target) ------------------------
  for (const it of items) {
    if (!it || it.id == null) continue;
    // A settled item can't itself be "waiting" on a dependency in a way that blocks the plan.
    if (SETTLED_STATUSES.has(lc(it.status))) continue;
    const deps = Array.isArray(it.depends_on) ? it.depends_on : [];
    const unsettled = [];
    for (const dep of deps) {
      if (dep == null || dep === '') continue;
      const depId = String(dep);
      const target = byId.get(depId);
      // Unknown (dangling) dependency OR a known-but-unsettled target both block the dependent.
      if (!target || !SETTLED_STATUSES.has(lc(target.status))) unsettled.push(depId);
    }
    if (unsettled.length === 0) continue;
    const itemId = String(it.id);
    const seen = it.first_seen || it.ts || null;
    // Severity is computed about the BLOCKED item (does ITS completion gate a demo / non-deferred?).
    const severity = computeSeverity({ isSecurityVeto: false, itemId, item: it, items });
    blockers.push({
      source: 'dependency-blocked',
      item_id: itemId,
      gate_id: null,
      severity,
      age_hours: ageHours(seen),
      first_seen: seen,
      reason: `blocked by unfinished dependency: ${unsettled.join(', ')}`,
      detail: it.goal || it.text || null,
    });
  }

  // Stable ordering: P0 → P1 → P2, then oldest (largest age) first within a severity. age==null
  // sorts last within its severity (unknown age is least-urgent among equals).
  const sevRank = { P0: 0, P1: 1, P2: 2 };
  blockers.sort((a, b) => {
    const ra = sevRank[a.severity] ?? 3;
    const rb = sevRank[b.severity] ?? 3;
    if (ra !== rb) return ra - rb;
    const ah = a.age_hours == null ? -1 : a.age_hours;
    const bh = b.age_hours == null ? -1 : b.age_hours;
    return bh - ah;
  });

  return blockers;
}

// ---------------------------------------------------------------------------------------------
// Render markdown
// ---------------------------------------------------------------------------------------------
function renderMarkdown({ blockers, counts, sources, stateDirTarget, commit, generatedAt, corruptNotes }) {
  const lines = [];
  lines.push('# Blockers');
  lines.push('');
  lines.push(`> _Auto-generated by \`bin/render-blockers.mjs\`. Source of truth: the \`*.jsonl\` ledger. Do not hand-edit._`);
  lines.push('');
  lines.push(`- **generated:** ${generatedAt}${commit ? ` · commit \`${commit}\`` : ''}`);
  lines.push(`- **sources scanned:** items=${sources.items}, gate_results=${sources.gate_results}, decisions=${sources.decisions}`);
  lines.push(`- **blockers found:** ${counts.total} (P0=${counts.P0}, P1=${counts.P1}, P2=${counts.P2})`);
  if (stateDirTarget) {
    lines.push(`- **sync target (orchestrator G7):** \`${stateDirTarget}\` — the propagate step mirrors this register into the repo state dir.`);
  }
  if (corruptNotes && corruptNotes.length) {
    lines.push('');
    lines.push(`> ⚠️ Ledger integrity: ${corruptNotes.join('; ')}.`);
  }
  lines.push('');

  if (blockers.length === 0) {
    lines.push('## No blockers');
    lines.push('');
    lines.push('_No open blockers across all five sources (question items, open gate fail/halt, security vetoes, missing decisions, dependency-blocked items). The path is clear._');
    lines.push('');
    return lines.join('\n') + '\n';
  }

  lines.push('## Register');
  lines.push('');
  lines.push('_Severity: **P0** = blocks a demo-path item or is a security veto · **P1** = blocks a non-deferred item · **P2** = other. Sorted P0→P2, oldest first within a severity._');
  lines.push('');
  lines.push('| # | Severity | Source | Item | Gate | Age (h) | Reason |');
  lines.push('|---:|---|---|---|---|---:|---|');
  blockers.forEach((b, i) => {
    lines.push(
      `| ${i + 1} | ${b.severity} | ${escMd(b.source)} | ${escMd(b.item_id || '—')} | ${escMd(b.gate_id || '—')} | ${b.age_hours == null ? '—' : b.age_hours} | ${escMd(b.reason)} |`,
    );
  });
  lines.push('');

  // A by-source breakdown so the register is easy to triage.
  lines.push('## By source');
  lines.push('');
  lines.push('| Source | Count |');
  lines.push('|---|---:|');
  const bySource = new Map();
  for (const b of blockers) bySource.set(b.source, (bySource.get(b.source) || 0) + 1);
  for (const [s, n] of [...bySource.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`| ${escMd(s)} | ${n} |`);
  }
  lines.push('');

  // Detail block for any blocker that carries one (kept out of the table to keep it scannable).
  const withDetail = blockers.filter((b) => b.detail);
  if (withDetail.length) {
    lines.push('## Detail');
    lines.push('');
    withDetail.forEach((b, i) => {
      const idx = blockers.indexOf(b) + 1;
      lines.push(`- **#${idx} (${b.severity}, ${escMd(b.source)}${b.item_id ? `, ${escMd(b.item_id)}` : ''}):** ${escMd(b.detail)}`);
    });
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------
function main() {
  // Config is the per-repo seam, but the renderer must still produce a valid artifact on a fresh
  // repo. We read it defensively (readConfigSafe) — NOT via lib.loadConfig(), which process.exit(1)s
  // on a missing file (untrappable by try/catch) and would otherwise abort the fresh-repo render.
  let cfg = readConfigSafe();
  if (!cfg || typeof cfg !== 'object') cfg = {};

  // The orchestrator's G7 propagate step mirrors this register into the repo state dir. We surface
  // that path (read from config.propagation.stateDir) but DO NOT write it — a renderer writes only
  // its single 'out' artifact. Degrades to null when the key is absent.
  const stateDir = cfg.propagation && cfg.propagation.stateDir ? String(cfg.propagation.stateDir) : null;
  const stateDirTarget = stateDir ? `${stateDir.replace(/[/\\]+$/, '')}/05-risks-and-blockers.md` : null;

  // Survey the three source ledgers defensively. All degrade to [] when missing/empty/corrupt.
  const itemsSurvey = surveyTable('items');
  const gatesSurvey = surveyTable('gate_results');
  const decisionsSurvey = surveyTable('decisions');

  const items = itemsSurvey.rows;
  const gateRows = gatesSurvey.rows;
  const decisions = decisionsSurvey.rows;

  const corruptNotes = [];
  if (itemsSurvey.corruptLines.length) corruptNotes.push(`items.jsonl: ${itemsSurvey.corruptLines.length} corrupt line(s) skipped`);
  if (gatesSurvey.corruptLines.length) corruptNotes.push(`gate_results.jsonl: ${gatesSurvey.corruptLines.length} corrupt line(s) skipped`);
  if (decisionsSurvey.corruptLines.length) corruptNotes.push(`decisions.jsonl: ${decisionsSurvey.corruptLines.length} corrupt line(s) skipped`);

  const blockers = buildBlockers({ items, gateRows, decisions });

  const counts = {
    total: blockers.length,
    P0: blockers.filter((b) => b.severity === 'P0').length,
    P1: blockers.filter((b) => b.severity === 'P1').length,
    P2: blockers.filter((b) => b.severity === 'P2').length,
  };

  // Best-effort current commit for provenance. git-absent → omit (graceful degradation).
  const head = tryGit('rev-parse --short HEAD');
  const commit = head && head.ok && head.out ? head.out : null;

  const generatedAt = nowIso();
  const md = renderMarkdown({
    blockers,
    counts,
    sources: { items: items.length, gate_results: gateRows.length, decisions: decisions.length },
    stateDirTarget,
    commit,
    generatedAt,
    corruptNotes,
  });

  // Write the single 'out' artifact: HOME/BLOCKERS.md. A write failure is REPORTED (not thrown)
  // and we still exit 0 — a renderer never blocks the loop.
  const outPath = join(HOME, 'BLOCKERS.md');
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
    counts,
    stateDirSyncTarget: stateDirTarget, // orchestrator G7 mirrors here; renderer does not write it
    sources: { items: items.length, gate_results: gateRows.length, decisions: decisions.length },
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
  out({ ok: true, written: false, error: `render-blockers degraded: ${e && e.message ? e.message : String(e)}` });
  process.exit(0);
}
