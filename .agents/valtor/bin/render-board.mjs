#!/usr/bin/env node
// render-board.mjs — projection 'board' (registry.json). Writes the exec BOARD.md.
//
//   node render-board.mjs
//
// RENDERER by contract: writes exactly ONE artifact — config-relative BOARD.md (HOME/BOARD.md,
// where HOME honors $VALTOR_HOME) — and never edits the tree otherwise. It REPORTS, never blocks:
// always exits 0 (even on an empty ledger). The single JSON object on stdout carries the path +
// summary counts so the orchestrator can confirm the regen without re-reading the file.
//
// The board is assembled entirely from the committed *.jsonl ledger (the source of truth):
//   items.jsonl              -> completion table (plan_id x phase x domain) + status pie + dep graph
//   gate_results.jsonl       -> 6 readiness gauges (BUILD/TEST/INTEGRATION/DEPLOY/DEMO-READY/SECURITY-CLEAR)
//   status_transitions.jsonl -> burn-down (open-vs-done over time)
//
// GRACEFUL DEGRADATION is the headline requirement: a missing file, an empty ledger, a missing
// config key, or git-absent all produce a VALID board (showing 0/0) + exit 0 — never a stack trace.
// Reading is done defensively (NOT lib.readRows(), which fails-fast on the first corrupt row) so a
// single bad line degrades to a skipped row + a note, never an abort.

// NOTE: we deliberately do NOT import/use lib's loadConfig(). loadConfig() calls lib.fail() ->
// process.exit(1) when the config seam is absent — and a try/catch CANNOT trap a process exit
// (it's not a throw). A renderer must degrade gracefully on a fresh repo (no config) by still
// writing a valid board + exiting 0. So we read the config with a local defensive reader
// (readConfigSafe), exactly like render-readiness.mjs / index-rebuild.mjs do. CONFIG_PATH/HOME/
// tablePath/tryGit/nowIso/out are all pure.
import { HOME, CONFIG_PATH, tablePath, tryGit, nowIso, ok, out } from './lib.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// Defensive config read — returns {} on an absent/corrupt config instead of exiting the process
// (lib.loadConfig() would process.exit(1), which no try/catch can trap). Fresh repo => {} => the
// board renders from defaults. This is the portability guarantee: a brand-new repo with no config
// + no ledger still produces a valid 0/0 BOARD.md and exits 0.
function readConfigSafe() {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch {
    return {}; // corrupt config -> fall back to defaults, still render
  }
}

// ---------------------------------------------------------------------------------------------
// Status model (SCHEMA §3 LoopItem.status). The board shows a fixed set of named columns; every
// other status still counts toward `total` (the honest denominator — §10) and is surfaced under
// an "other statuses" note so the % can never silently lie.
// ---------------------------------------------------------------------------------------------
const STATUS_COLUMNS = ['done', 'deferred', 'open', 'in_progress', 'blocked', 'question'];
// Statuses that we treat as an explicit "blocked" bucket for the board column. `debugging` is an
// active failure-triage state; a row carrying blocked_by_subtree_root is structurally blocked.
const BLOCKED_STATUSES = new Set(['blocked', 'debugging']);
// Statuses that DON'T get a dedicated column but must still be counted into total + listed.
// (superseded / stale / orphan and any unknown future status fall through to here.)
const DONE_STATUSES = new Set(['done']);

// readiness gauges (SCHEMA §10). overall = min(), not mean.
const READINESS_DIMS_DEFAULT = ['BUILD', 'TEST', 'INTEGRATION', 'DEPLOY', 'DEMO-READY', 'SECURITY-CLEAR'];

// ---------------------------------------------------------------------------------------------
// Defensive jsonl reader. Mirrors index-rebuild.mjs: survey every line, skip + count corrupt ones,
// never throw, never mutate the file. Returns { rows, corruptLines, missing }.
// ---------------------------------------------------------------------------------------------
function surveyTable(table) {
  const p = tablePath(table);
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
function pct(numerator, denominator) {
  if (!denominator || denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10; // one decimal
}
function escMd(s) {
  // Keep Markdown table cells from breaking on a literal pipe or newline.
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}
function emptyLabel(s) { return s == null || s === '' ? '(none)' : String(s); }

// A simple ASCII gauge bar [#####-----] for the readiness section (works in any renderer).
function bar(value, width = 20) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const filled = Math.round((v / 100) * width);
  return '`[' + '#'.repeat(filled) + '-'.repeat(width - filled) + ']`';
}

// Classify an item.status into one of the board columns; returns the column name or null (=> the
// row still counts toward total but lands in the "other statuses" tally).
function columnFor(status) {
  const s = String(status || '').toLowerCase();
  if (DONE_STATUSES.has(s)) return 'done';
  if (s === 'deferred') return 'deferred';
  if (s === 'open') return 'open';
  if (s === 'in_progress') return 'in_progress';
  if (s === 'question') return 'question';
  if (BLOCKED_STATUSES.has(s)) return 'blocked';
  return null; // superseded / stale / orphan / unknown
}

function blankCounts() {
  const c = { total: 0, other: 0 };
  for (const col of STATUS_COLUMNS) c[col] = 0;
  return c;
}

// ---------------------------------------------------------------------------------------------
// Completion table: rows = (plan_id x phase x domain). out_of_scope items are EXCLUDED from totals
// and collected separately. deferred is its own column (honest denominator — never hidden).
// ---------------------------------------------------------------------------------------------
function buildCompletion(items) {
  const groups = new Map(); // key -> { plan_id, phase, domain, counts }
  const grandTotal = blankCounts();
  const outOfScope = []; // { id, plan_id, phase, domain, status }
  const otherStatusTally = new Map(); // status -> count (the non-column statuses)

  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (it.out_of_scope === true) {
      outOfScope.push({
        id: it.id ?? null, plan_id: emptyLabel(it.plan_id), phase: emptyLabel(it.phase),
        domain: emptyLabel(it.domain), status: it.status ?? null,
      });
      continue;
    }
    const plan_id = emptyLabel(it.plan_id);
    const phase = emptyLabel(it.phase);
    const domain = emptyLabel(it.domain);
    const key = `${plan_id}|${phase}|${domain}`;
    if (!groups.has(key)) groups.set(key, { plan_id, phase, domain, counts: blankCounts() });
    const g = groups.get(key);

    // A row carrying blocked_by_subtree_root is structurally blocked even if its status string
    // hasn't been flipped — count it in the blocked column rather than its raw status.
    const structurallyBlocked = it.blocked_by_subtree_root != null && it.blocked_by_subtree_root !== '';
    const col = structurallyBlocked ? 'blocked' : columnFor(it.status);

    g.counts.total += 1;
    grandTotal.total += 1;
    if (col) {
      g.counts[col] += 1;
      grandTotal[col] += 1;
    } else {
      g.counts.other += 1;
      grandTotal.other += 1;
      const s = String(it.status || 'unknown');
      otherStatusTally.set(s, (otherStatusTally.get(s) || 0) + 1);
    }
  }

  // Stable sort: plan_id, then phase, then domain (lexicographic).
  const rows = [...groups.values()].sort((a, b) =>
    a.plan_id.localeCompare(b.plan_id) || a.phase.localeCompare(b.phase) || a.domain.localeCompare(b.domain));

  return { rows, grandTotal, outOfScope, otherStatusTally };
}

function renderCompletionTable(completion) {
  const { rows, grandTotal, otherStatusTally } = completion;
  const head = '| Plan | Phase | Domain | done | deferred | open | in_progress | blocked | question | total | pct |';
  const sep = '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|';
  const lines = [head, sep];

  const rowToCells = (label3, c) => {
    const p = pct(c.done, c.total);
    return `| ${label3} | ${c.done} | ${c.deferred} | ${c.open} | ${c.in_progress} | ${c.blocked} | ${c.question} | ${c.total} | ${p}% |`;
  };

  if (rows.length === 0) {
    lines.push('| _(no in-scope items)_ | | | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0% |');
  } else {
    for (const r of rows) {
      const label3 = `${escMd(r.plan_id)} | ${escMd(r.phase)} | ${escMd(r.domain)}`;
      lines.push(rowToCells(label3, r.counts));
    }
  }
  // Grand total row.
  lines.push(rowToCells('**TOTAL** |  | ', grandTotal));

  let md = lines.join('\n');

  // Surface any status that didn't get its own column (kept in total, never hidden).
  if (otherStatusTally.size > 0) {
    const parts = [...otherStatusTally.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([s, n]) => `\`${escMd(s)}\`: ${n}`);
    md += `\n\n> Other statuses (counted in **total**, no dedicated column): ${parts.join(', ')}.`;
  }
  return md;
}

function renderOutOfScope(outOfScope) {
  if (!outOfScope.length) {
    return '_No out-of-scope items. (Out-of-scope items are excluded from the completion totals above and listed here when present.)_';
  }
  const lines = [
    '_Excluded from the completion denominator above (honest denominator — §10)._',
    '',
    '| Item | Plan | Phase | Domain | Status |',
    '|---|---|---|---|---|',
  ];
  for (const o of outOfScope) {
    lines.push(`| ${escMd(o.id)} | ${escMd(o.plan_id)} | ${escMd(o.phase)} | ${escMd(o.domain)} | ${escMd(o.status)} |`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Readiness gauges (SCHEMA §10) — derived from gate_results, same source as render-readiness.
// Each dimension is a pass-rate 0-100 over a relevant slice of gate_results; overall = min().
// Mapping gate_id -> dimension is best-effort + substring-based so it degrades on partial data.
// BUILD additionally folds in items integrated/total (a project with no gate rows still shows a
// truthful BUILD number from item status). A dimension with no signal renders as "n/a" and is
// EXCLUDED from the min() (so a fresh repo reads overall n/a, not a misleading 0).
// ---------------------------------------------------------------------------------------------
function dimensionForGate(gateId) {
  const g = String(gateId || '').toLowerCase();
  if (/(g2-arch|arch-security|negative-authz|security|veto)/.test(g)) return 'SECURITY-CLEAR';
  if (/(g5\.5|deploy-health|g5-smoke|smoke|g5-negative)/.test(g)) {
    // negative-authz is security-clear; smoke / deploy-health are DEPLOY.
    if (/negative-authz/.test(g)) return 'SECURITY-CLEAR';
    return 'DEPLOY';
  }
  if (/(g5|deploy)/.test(g)) return 'DEPLOY';
  if (/(g4c|contract|g-e2e|e2e|integrat)/.test(g)) return 'INTEGRATION';
  if (/(gv|verify|g4b|review|g4|test|gap|nfr)/.test(g)) return 'TEST';
  if (/(g2b|ready|g1|reconcile|build)/.test(g)) return 'BUILD';
  return null;
}

// A gate outcome -> {pass, counted}. pass|fail count toward the rate; halt/surfaced/skipped/other
// are not pass-rate signal (they don't count for or against).
function gateSignal(outcome) {
  const o = String(outcome || '').toLowerCase();
  if (o === 'pass') return { counted: true, pass: true };
  if (o === 'fail') return { counted: true, pass: false };
  return { counted: false, pass: false };
}

function buildReadiness(dims, gateRows, items) {
  // Latest outcome per (item_id, gate_id) so re-runs don't double-count; ties broken by ts.
  const latest = new Map(); // key -> row
  for (const r of gateRows) {
    if (!r || typeof r !== 'object') continue;
    const key = `${r.item_id ?? ''}|${r.gate_id ?? ''}`;
    const prev = latest.get(key);
    if (!prev) { latest.set(key, r); continue; }
    const a = String(r.ts || ''); const b = String(prev.ts || '');
    if (a >= b) latest.set(key, r);
  }

  const acc = {}; // dim -> { counted, pass }
  for (const d of dims) acc[d] = { counted: 0, pass: 0 };

  for (const r of latest.values()) {
    const dim = dimensionForGate(r.gate_id);
    if (!dim || !acc[dim]) continue;
    const sig = gateSignal(r.outcome);
    if (!sig.counted) continue;
    acc[dim].counted += 1;
    if (sig.pass) acc[dim].pass += 1;
  }

  // BUILD also reflects item integration (done / in-scope total) — a truthful number even when no
  // gate rows exist. Combine with gate-derived BUILD as a min (weakest signal wins, §10 spirit).
  const inScope = items.filter((it) => it && it.out_of_scope !== true);
  const doneCount = inScope.filter((it) => DONE_STATUSES.has(String(it.status || '').toLowerCase())).length;
  const buildFromItems = inScope.length > 0 ? pct(doneCount, inScope.length) : null;

  const scores = {}; // dim -> number | null
  for (const d of dims) {
    const a = acc[d];
    let gateScore = a.counted > 0 ? pct(a.pass, a.counted) : null;
    if (d === 'BUILD') {
      if (buildFromItems == null && gateScore == null) scores[d] = null;
      else if (buildFromItems == null) scores[d] = gateScore;
      else if (gateScore == null) scores[d] = buildFromItems;
      else scores[d] = Math.min(gateScore, buildFromItems);
    } else {
      scores[d] = gateScore;
    }
  }

  // overall = min() across dimensions that HAVE a signal; null if none do.
  const present = dims.map((d) => scores[d]).filter((v) => v != null);
  const overall = present.length ? Math.min(...present) : null;

  return { scores, overall, acc, buildFromItems };
}

function renderReadiness(dims, readiness) {
  const lines = [
    '| Dimension | Score | Gauge |',
    '|---|---:|---|',
  ];
  for (const d of dims) {
    const v = readiness.scores[d];
    if (v == null) lines.push(`| ${d} | n/a | \`[--------------------]\` |`);
    else lines.push(`| ${d} | ${v}% | ${bar(v)} |`);
  }
  const o = readiness.overall;
  lines.push(`| **OVERALL** (min) | ${o == null ? 'n/a' : o + '%'} | ${o == null ? '`[--------------------]`' : bar(o)} |`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Mermaid: status pie, dependency graph (depends_on), phase progress bar.
// ---------------------------------------------------------------------------------------------
function renderStatusPie(items) {
  // Count by raw status across in-scope items.
  const tally = new Map();
  let any = false;
  for (const it of items) {
    if (!it || it.out_of_scope === true) continue;
    any = true;
    const s = String(it.status || 'unknown');
    tally.set(s, (tally.get(s) || 0) + 1);
  }
  const lines = ['```mermaid', 'pie showData title Items by status (in-scope)'];
  if (!any) {
    lines.push('  "no items" : 0');
  } else {
    for (const [s, n] of [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      // Mermaid pie labels are quoted strings; strip embedded quotes.
      lines.push(`  "${String(s).replace(/"/g, '')}" : ${n}`);
    }
  }
  lines.push('```');
  return lines.join('\n');
}

// Sanitize an id into a Mermaid-safe node id (alnum + underscore). Keep a label with the original.
function mermaidNodeId(id, seen) {
  let base = String(id == null ? 'unknown' : id).replace(/[^A-Za-z0-9_]/g, '_');
  if (!base) base = 'n';
  if (!/^[A-Za-z_]/.test(base)) base = 'n_' + base;
  let candidate = base;
  let i = 1;
  while (seen.has(candidate) && seen.get(candidate) !== id) { candidate = `${base}_${i++}`; }
  seen.set(candidate, id);
  return candidate;
}

function renderDepGraph(items) {
  // Build id -> item for label/status lookup. Only emit edges where both endpoints are known OR
  // the target id appears (dangling deps still drawn as a node so the graph is honest).
  const byId = new Map();
  for (const it of items) {
    if (!it || it.id == null) continue;
    byId.set(String(it.id), it);
  }
  const edges = []; // [fromId, toId]
  for (const it of items) {
    if (!it || it.id == null) continue;
    const deps = Array.isArray(it.depends_on) ? it.depends_on : [];
    for (const d of deps) {
      if (d == null || d === '') continue;
      edges.push([String(it.id), String(d)]);
    }
  }

  if (edges.length === 0) {
    return '```mermaid\ngraph LR\n  none["no depends_on edges"]\n```';
  }

  // Stable, bounded: cap at a sane number of edges so a huge plan doesn't produce an unreadable
  // diagram. The full graph lives in graph.jsonl; this is the human glance.
  const MAX_EDGES = 200;
  const shown = edges.slice(0, MAX_EDGES);
  const idMap = new Map(); // originalId -> mermaidId
  const seen = new Map();
  const nodeIdFor = (origId) => {
    if (idMap.has(origId)) return idMap.get(origId);
    const mid = mermaidNodeId(origId, seen);
    idMap.set(origId, mid);
    return mid;
  };

  const lines = ['```mermaid', 'graph LR'];
  // Declare nodes (with status-tagged labels) for every endpoint we touch.
  const endpoints = new Set();
  for (const [f, t] of shown) { endpoints.add(f); endpoints.add(t); }
  for (const origId of endpoints) {
    const mid = nodeIdFor(origId);
    const it = byId.get(origId);
    const status = it ? String(it.status || '') : 'unknown';
    const label = `${origId}${status ? ` (${status})` : ''}`.replace(/[\]"]/g, '');
    lines.push(`  ${mid}["${label}"]`);
  }
  for (const [f, t] of shown) {
    // "f depends_on t" => t must come first: draw t --> f (arrow points to the dependent).
    lines.push(`  ${nodeIdFor(t)} --> ${nodeIdFor(f)}`);
  }
  if (edges.length > MAX_EDGES) lines.push(`  more["+ ${edges.length - MAX_EDGES} more edges (see graph.jsonl)"]`);
  lines.push('```');
  return lines.join('\n');
}

function renderPhaseBar(items) {
  // Per-phase done/total bar (in-scope). Rendered as a Mermaid gantt-ish... no — keep it a simple
  // text table with a unicode bar; it's the most portable + readable "progress bar".
  const byPhase = new Map(); // phase -> { done, total }
  for (const it of items) {
    if (!it || it.out_of_scope === true) continue;
    const phase = emptyLabel(it.phase);
    if (!byPhase.has(phase)) byPhase.set(phase, { done: 0, total: 0 });
    const p = byPhase.get(phase);
    p.total += 1;
    if (DONE_STATUSES.has(String(it.status || '').toLowerCase())) p.done += 1;
  }
  if (byPhase.size === 0) return '_No phases to chart (empty ledger)._';

  const lines = ['| Phase | Progress | done / total |', '|---|---|---:|'];
  for (const [phase, p] of [...byPhase.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const pc = pct(p.done, p.total);
    const width = 20;
    const filled = Math.round((pc / 100) * width);
    const barTxt = '`' + '#'.repeat(filled) + '-'.repeat(width - filled) + '` ' + pc + '%';
    lines.push(`| ${escMd(phase)} | ${barTxt} | ${p.done} / ${p.total} |`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Burn-down from status_transitions: cumulative done over time vs total scope known at that point.
// Best-effort: we bucket transitions by date (UTC) and track cumulative -> done / leaving done.
// ---------------------------------------------------------------------------------------------
function renderBurnDown(transitions, items) {
  const rows = transitions
    .filter((t) => t && typeof t === 'object' && t.ts)
    .slice()
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  const totalScope = items.filter((it) => it && it.out_of_scope !== true).length;

  if (rows.length === 0) {
    return `_No status transitions recorded yet — burn-down begins once items change status. (Current in-scope total: ${totalScope}.)_`;
  }

  // Cumulative done by day. A transition INTO done increments; OUT of done decrements.
  const byDay = new Map(); // date -> net delta to done count
  for (const t of rows) {
    const day = String(t.ts).slice(0, 10);
    const to = String(t.to_status || '').toLowerCase();
    const from = String(t.from_status || '').toLowerCase();
    let delta = 0;
    if (DONE_STATUSES.has(to) && !DONE_STATUSES.has(from)) delta += 1;
    if (DONE_STATUSES.has(from) && !DONE_STATUSES.has(to)) delta -= 1;
    if (delta !== 0) byDay.set(day, (byDay.get(day) || 0) + delta);
  }

  if (byDay.size === 0) {
    return `_${rows.length} transition(s) recorded, none into/out of \`done\` yet — nothing to burn down. (In-scope total: ${totalScope}.)_`;
  }

  const days = [...byDay.keys()].sort();
  const lines = ['| Date (UTC) | Done (cumulative) | Remaining (of in-scope total) |', '|---|---:|---:|'];
  let cum = 0;
  for (const d of days) {
    cum += byDay.get(d);
    if (cum < 0) cum = 0;
    const remaining = totalScope > 0 ? Math.max(totalScope - cum, 0) : 0;
    lines.push(`| ${d} | ${cum} | ${totalScope > 0 ? remaining : 'n/a'} |`);
  }
  lines.push(`\n> In-scope total used as the burn-down baseline: **${totalScope}**.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Top blockers: P0 items + items aging (oldest first_seen / ts among not-done items). Also folds in
// structurally-blocked rows.
// ---------------------------------------------------------------------------------------------
function ageHours(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.round(((Date.now() - t) / 36e5) * 10) / 10;
}

function renderBlockers(items, staleHours) {
  const open = items.filter((it) => {
    if (!it || it.out_of_scope === true) return false;
    return !DONE_STATUSES.has(String(it.status || '').toLowerCase()) && String(it.status || '').toLowerCase() !== 'deferred';
  });

  const scored = open.map((it) => {
    const seen = it.first_seen || it.ts || null;
    const age = ageHours(seen);
    const sev = String(it.severity || '').toUpperCase();
    const isP0 = sev === 'P0';
    const structurallyBlocked = it.blocked_by_subtree_root != null && it.blocked_by_subtree_root !== '';
    const isBlockedStatus = BLOCKED_STATUSES.has(String(it.status || '').toLowerCase());
    const aging = age != null && staleHours > 0 && age >= staleHours;
    const flag = isP0 || structurallyBlocked || isBlockedStatus || aging;
    return { it, age, sev, isP0, structurallyBlocked, isBlockedStatus, aging, flag };
  }).filter((x) => x.flag);

  // Sort: P0 first, then by age desc (oldest = most urgent).
  scored.sort((a, b) => {
    if (a.isP0 !== b.isP0) return a.isP0 ? -1 : 1;
    const ah = a.age == null ? -1 : a.age; const bh = b.age == null ? -1 : b.age;
    return bh - ah;
  });

  if (scored.length === 0) {
    return '_No blockers: no P0s, no structurally-blocked items, none aging past the staleness threshold._';
  }

  const lines = ['| Item | Sev | Status | Age (h) | Why flagged | Goal |', '|---|---|---|---:|---|---|'];
  const TOP = 25;
  for (const x of scored.slice(0, TOP)) {
    const reasons = [];
    if (x.isP0) reasons.push('P0');
    if (x.structurallyBlocked) reasons.push(`blocked-by ${escMd(x.it.blocked_by_subtree_root)}`);
    if (x.isBlockedStatus && !x.structurallyBlocked) reasons.push('blocked-status');
    if (x.aging) reasons.push(`aging ≥ ${staleHours}h`);
    lines.push(`| ${escMd(x.it.id)} | ${escMd(x.sev || '—')} | ${escMd(x.it.status)} | ${x.age == null ? '—' : x.age} | ${escMd(reasons.join(', '))} | ${escMd(x.it.goal)} |`);
  }
  if (scored.length > TOP) lines.push(`\n> + ${scored.length - TOP} more flagged item(s) not shown.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Assemble + write
// ---------------------------------------------------------------------------------------------
function main() {
  // Config is the per-repo seam. We don't hard-require it (the board must render on a fresh repo),
  // so we read it defensively (readConfigSafe() returns {} on absent/corrupt — never exits) and
  // pull the readiness dimensions + blocker-stale threshold from it when present.
  let cfg = readConfigSafe();
  if (!cfg || typeof cfg !== 'object') cfg = {};

  const dims = Array.isArray(cfg.readinessModel && cfg.readinessModel.dimensions) && cfg.readinessModel.dimensions.length
    ? cfg.readinessModel.dimensions
    : READINESS_DIMS_DEFAULT;
  const staleHours = Number(cfg.blockerStaleHours) > 0 ? Number(cfg.blockerStaleHours) : 48;

  // Survey the three ledger tables the board reads. All degrade to [] when missing/empty.
  const itemsSurvey = surveyTable('items');
  const gatesSurvey = surveyTable('gate_results');
  const transSurvey = surveyTable('status_transitions');

  const items = itemsSurvey.rows;
  const gateRows = gatesSurvey.rows;
  const transitions = transSurvey.rows;

  const corruptNotes = [];
  if (itemsSurvey.corruptLines.length) corruptNotes.push(`items.jsonl: ${itemsSurvey.corruptLines.length} corrupt line(s) skipped`);
  if (gatesSurvey.corruptLines.length) corruptNotes.push(`gate_results.jsonl: ${gatesSurvey.corruptLines.length} corrupt line(s) skipped`);
  if (transSurvey.corruptLines.length) corruptNotes.push(`status_transitions.jsonl: ${transSurvey.corruptLines.length} corrupt line(s) skipped`);

  // Stamps.
  const shortSha = (() => {
    const r = tryGit('rev-parse --short HEAD');
    return r.ok && r.out ? r.out : null;
  })();
  const asOfTs = nowIso();

  // Build sections.
  const completion = buildCompletion(items);
  const readiness = buildReadiness(dims, gateRows, items);

  const md = [
    '# Valtor Exec Board',
    '',
    `> _Auto-generated by \`bin/render-board.mjs\`. Source of truth: the \`*.jsonl\` ledger. Do not hand-edit._`,
    '',
    `- **as_of_commit:** ${shortSha ? '`' + shortSha + '`' : '_(git unavailable / no commits)_'}`,
    `- **as_of_ts:** ${asOfTs}`,
    `- **items:** ${items.length} total in ledger (${completion.grandTotal.total} in-scope, ${completion.outOfScope.length} out-of-scope)`,
    `- **gate_results:** ${gateRows.length} · **status_transitions:** ${transitions.length}`,
    ...(corruptNotes.length ? ['', `> ⚠️ Ledger integrity: ${corruptNotes.join('; ')}.`] : []),
    '',
    '## Completion',
    '',
    '_Rows = (plan_id × phase × domain). `total` = sum of ALL statuses (the honest denominator, §10). `deferred` is its own column — never hidden. `out_of_scope` items are excluded here and listed below._',
    '',
    renderCompletionTable(completion),
    '',
    '### Out-of-scope items',
    '',
    renderOutOfScope(completion.outOfScope),
    '',
    '## Readiness gauges',
    '',
    `_6 dimensions scored 0–100 from \`gate_results\` (latest outcome per item×gate). **Overall = min()** — a project is only as ready as its weakest dimension (§10). \`n/a\` = no signal yet; excluded from the min._`,
    '',
    renderReadiness(dims, readiness),
    '',
    '## Status pie',
    '',
    renderStatusPie(items),
    '',
    '## Dependency graph (`depends_on`)',
    '',
    '_Arrows point from a dependency to the item that depends on it. Full graph in `index/graph.jsonl`._',
    '',
    renderDepGraph(items),
    '',
    '## Phase progress',
    '',
    renderPhaseBar(items),
    '',
    '## Burn-down',
    '',
    '_Cumulative items reaching `done` over time, from `status_transitions`._',
    '',
    renderBurnDown(transitions, items),
    '',
    '## Top blockers',
    '',
    `_P0 items + structurally-blocked items + items aging ≥ ${staleHours}h (config.blockerStaleHours). Oldest first._`,
    '',
    renderBlockers(items, staleHours),
    '',
  ].join('\n');

  // Write the single artifact: HOME/BOARD.md (HOME honors $VALTOR_HOME).
  const outPath = join(HOME, 'BOARD.md');
  try {
    const dir = dirname(outPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(outPath, md);
  } catch (e) {
    // A renderer that can't write its artifact still REPORTS (exit 0) — surface the error in JSON.
    out({ ok: false, error: `could not write board to ${outPath}: ${e && e.message ? e.message : String(e)}`, path: outPath });
    process.exit(0);
    return;
  }

  return ok({
    path: outPath,
    as_of_commit: shortSha,
    as_of_ts: asOfTs,
    items: { total: items.length, inScope: completion.grandTotal.total, outOfScope: completion.outOfScope.length },
    completion: {
      done: completion.grandTotal.done,
      deferred: completion.grandTotal.deferred,
      open: completion.grandTotal.open,
      in_progress: completion.grandTotal.in_progress,
      blocked: completion.grandTotal.blocked,
      question: completion.grandTotal.question,
      other: completion.grandTotal.other,
      total: completion.grandTotal.total,
      pct: pct(completion.grandTotal.done, completion.grandTotal.total),
    },
    readiness: { scores: readiness.scores, overall: readiness.overall },
    rows: completion.rows.length,
    gate_results: gateRows.length,
    status_transitions: transitions.length,
    ...(corruptNotes.length ? { integrityNotes: corruptNotes } : {}),
    bytes: Buffer.byteLength(md),
  });
}

try {
  main();
} catch (e) {
  // Renderers report, never block: even a last-resort failure exits 0 with clean JSON so the loop
  // is never halted by a board-render hiccup.
  out({ ok: false, error: `render-board failed unexpectedly: ${e && e.message ? e.message : String(e)}` });
  process.exit(0);
}
