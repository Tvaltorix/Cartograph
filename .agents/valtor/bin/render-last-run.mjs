#!/usr/bin/env node
// render-last-run.mjs — projection 'run-journal-digest' (registry.json) → HOME/last-run.md.
//
//   node render-last-run.mjs
//
// Digests the MOST RECENT run from the run-journal ledger (SCHEMA §3.1 run_journal:
//   { ts, instance_id, run_id, state, action, item_id?, gate_id?, gate_mode, deploy_run_id?,
//     outcome, budget_counters, halt_case?, decision_id? }).
// Groups rows by run_id, takes the newest run, and renders a human digest: the state transitions
// it walked, gates that fired (with run_kind script|reasoning), dispatches, deploys, halts, and
// decisions. Empty/absent journal → a valid file that says "no runs recorded yet".
//
// RENDERER CONTRACT (registry projection — mirrors render-readiness.mjs):
//   * Writes ONLY its single 'out' artifact (HOME/last-run.md). Touches nothing else in the tree.
//   * Reports, never blocks: ALWAYS exit 0 (even on an empty/absent journal or a write hiccup).
//   * Reads every repo-specific value from the config seam; nothing repo-specific is hardcoded.
//
// GRACEFUL DEGRADATION (the headline requirement):
//   * Absent journal / empty journal / corrupt rows / missing config key / git-absent → a VALID
//     last-run.md is still written and exit 0. Never a stack trace.
//
// NAMING NOTE (why we read two candidate files): SCHEMA §3.1/§8, lib.TABLES, and init.mjs all use
//   `run_journal.jsonl` (underscore — the file appendRow() writes). config.index.runJournal and the
//   registry intent text say `run-journal.jsonl` (hyphen). Rather than guess, we read BOTH (config
//   path first, then the canonical underscore table) and merge — so the digest finds the data no
//   matter which writer produced it. De-dup is by (run_id, ts, action, state) identity.

// We deliberately do NOT import lib's loadConfig()/readRows(): both call lib.fail() →
// process.exit(1) on a missing/corrupt config or a single corrupt jsonl row, which a try/catch
// CANNOT trap (it's a process exit, not a throw). A renderer must degrade gracefully — still write
// a valid artifact and exit 0 — so we read the config + ledger with local defensive readers
// (the same reason render-readiness.mjs / index-rebuild.mjs avoid readRows()). INDEX/HOME/nowIso/
// tryGit/out are pure.
import { INDEX, HOME, CONFIG_PATH, nowIso, tryGit, out } from './lib.mjs';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve, basename } from 'node:path';

// Resolve the journal-filename the config seam declares (config.index.runJournal, often the hyphen
// spelling) to a candidate UNDER INDEX. We honor only the BASENAME, never the directory: INDEX is
// VALTOR_HOME/index, and VALTOR_HOME is the isolation boundary — a config path that is repo-root-
// relative must NOT pull the script back out to cwd (that would break the portability guarantee +
// the isolated-temp-home verification harness, and could read a different repo's journal). An
// absolute config path is honored as-is (an operator who hardcodes an absolute path means it).
function cfgJournalCandidate(cfg) {
  const cfgPath = cfg && cfg.index && cfg.index.runJournal;
  if (!cfgPath) return null;
  if (isAbsolute(cfgPath)) return cfgPath;
  let base;
  try { base = basename(cfgPath); } catch { base = null; }
  return base ? join(INDEX, base) : null;
}

// Defensive config read — returns {} on absent/corrupt config instead of exiting the process.
function readConfigSafe() {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch {
    return {}; // corrupt config → fall back to defaults, still render
  }
}

// Defensive jsonl read from an absolute-or-relative path. Returns parsed rows, SKIPPING any line
// that fails to parse (never exits, never throws). Absent/empty file → []. Mirrors render-readiness
// / index-rebuild tolerance.
function readJsonlSafe(p) {
  try {
    if (!p || !existsSync(p)) return [];
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

// Read the run-journal from every candidate location and merge. We accept that VALTOR_HOME may
// relocate INDEX, so the canonical underscore table is resolved under INDEX; the config path is
// honored as given (it may be repo-root-relative or absolute). De-dup keeps the first-seen row of
// any identical (run_id|ts|state|action|gate_id|outcome) tuple.
function readJournal(cfg) {
  const candidates = [];
  // 1) The canonical table appendRow() writes (lib.TABLES → run_journal.jsonl), under INDEX.
  candidates.push(join(INDEX, 'run_journal.jsonl'));
  // 2) config.index.runJournal (often the hyphen spelling), mapped to its basename UNDER INDEX so
  //    VALTOR_HOME stays the isolation boundary (an absolute config path is honored as-is).
  const cfgCand = cfgJournalCandidate(cfg);
  if (cfgCand) candidates.push(cfgCand);
  // 3) The hyphen spelling under INDEX, in case a writer used it there.
  candidates.push(join(INDEX, 'run-journal.jsonl'));

  // De-dup the candidate PATHS first (resolve so the same file under two spellings collapses).
  const seenPaths = new Set();
  const merged = [];
  const seenRows = new Set();
  for (const c of candidates) {
    let key;
    try { key = resolve(c); } catch { key = c; }
    if (seenPaths.has(key)) continue;
    seenPaths.add(key);
    for (const r of readJsonlSafe(c)) {
      if (!r || typeof r !== 'object') continue;
      const rid = `${r.run_id ?? ''}|${r.ts ?? ''}|${r.state ?? ''}|${r.action ?? ''}|${r.gate_id ?? ''}|${r.outcome ?? ''}|${r.item_id ?? ''}`;
      if (seenRows.has(rid)) continue;
      seenRows.add(rid);
      merged.push(r);
    }
  }
  return merged;
}

// ---- small helpers ----------------------------------------------------------------------------

const lc = (s) => String(s == null ? '' : s).toLowerCase();

// Best-effort comparable timestamp. A bad/absent ts sorts to the epoch start so well-stamped rows
// always win the "most recent" race; we keep array order as the tiebreaker (append order).
function tsValue(r) {
  const t = r && r.ts;
  if (!t) return 0;
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : 0;
}

// Pick the most recent run. "Most recent" = the run_id whose rows include the latest ts; ties fall
// back to the run_id that appears latest in the file (append order). Rows missing a run_id are
// grouped under a synthetic "(no run_id)" bucket so they still surface rather than vanish.
function pickLatestRun(rows) {
  const groups = new Map(); // run_id -> { rows:[], maxTs, lastIndex }
  rows.forEach((r, i) => {
    const id = r.run_id != null && String(r.run_id).trim() !== '' ? String(r.run_id) : '(no run_id)';
    let g = groups.get(id);
    if (!g) { g = { run_id: id, rows: [], maxTs: -1, lastIndex: -1 }; groups.set(id, g); }
    g.rows.push(r);
    const tv = tsValue(r);
    if (tv > g.maxTs) g.maxTs = tv;
    if (i > g.lastIndex) g.lastIndex = i;
  });
  if (groups.size === 0) return null;
  let best = null;
  for (const g of groups.values()) {
    if (!best) { best = g; continue; }
    if (g.maxTs > best.maxTs) { best = g; continue; }
    if (g.maxTs === best.maxTs && g.lastIndex > best.lastIndex) best = g;
  }
  // Order the chosen run's rows chronologically (stable on equal ts via original index).
  const indexed = best.rows.map((r, i) => ({ r, i }));
  indexed.sort((a, b) => (tsValue(a.r) - tsValue(b.r)) || (a.i - b.i));
  return { run_id: best.run_id, rows: indexed.map((x) => x.r), runCount: groups.size };
}

// Normalize a gate's run mode. SCHEMA gate_results uses run_kind:"script|orchestrator-reasoning";
// the run_journal row carries gate_mode. We accept either field and any spelling, mapping to a
// terse "script" | "reasoning" label (the spec asks for run_kind script|reasoning).
function gateRunKind(r) {
  const raw = lc(r.gate_mode || r.run_kind);
  if (!raw) return 'unspecified';
  if (raw.includes('script')) return 'script';
  if (raw.includes('reason')) return 'reasoning'; // "orchestrator-reasoning" → reasoning
  return raw;
}

// Heuristic row classifiers. The journal's `action` is free-ish text; we classify by the most
// reliable structural signals (presence of gate_id, deploy_run_id, halt_case, decision_id) and
// fall back to keyword sniffing on `action`/`state`. Everything is best-effort + side-effect free.
function isGate(r) { return r.gate_id != null && String(r.gate_id).trim() !== ''; }
function isDeploy(r) {
  if (r.deploy_run_id != null && String(r.deploy_run_id).trim() !== '') return true;
  const a = lc(r.action);
  return a.includes('deploy') || lc(r.state).includes('deploy');
}
function isHalt(r) {
  if (r.halt_case != null && String(r.halt_case).trim() !== '') return true;
  const a = lc(r.action);
  return a.includes('halt') || a === 's-ask' || lc(r.state) === 's-ask' || lc(r.outcome) === 'halt';
}
function isDecision(r) {
  if (r.decision_id != null && String(r.decision_id).trim() !== '') return true;
  return lc(r.action).includes('decision') || lc(r.action).includes('decide');
}
function isDispatch(r) {
  const a = lc(r.action);
  return a.includes('dispatch') || a.includes('fork') || lc(r.state) === 's5' || lc(r.state).includes('dispatch');
}

// Markdown table-cell escape (pipes + newlines would break a row).
function cell(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim() || '—';
}

// Format an outcome with a small glyph so the digest scans fast. Unknown outcomes pass through.
function outcomeGlyph(outcome) {
  const o = lc(outcome);
  if (o === 'pass' || o === 'green' || o === 'ok' || o === 'success') return '✓';
  if (o === 'fail' || o === 'red' || o === 'error') return '✗';
  if (o === 'halt') return '⛔';
  if (o === 'surfaced') return '⚠';
  if (o === 'cancelled' || o === 'skipped' || o.startsWith('skipped')) return '∅';
  return '';
}
function fmtOutcome(outcome) {
  if (outcome == null || String(outcome).trim() === '') return '—';
  const g = outcomeGlyph(outcome);
  return g ? `${g} ${outcome}` : String(outcome);
}

// ---- render -----------------------------------------------------------------------------------

function renderEmpty({ generatedAt, commit, sources }) {
  const lines = [];
  lines.push('# Last Run');
  lines.push('');
  lines.push(`_Generated ${generatedAt}${commit ? ` · commit \`${commit}\`` : ''}._`);
  lines.push('');
  lines.push('No runs recorded yet.');
  lines.push('');
  lines.push('> The run-journal ledger is empty or absent. Valtor writes a `run_journal` row at each');
  lines.push('> state transition, gate firing, dispatch, deploy, halt, and decision; once a run executes,');
  lines.push('> this digest will summarize the most recent one.');
  lines.push('');
  lines.push('| Source | Path | Rows |');
  lines.push('|---|---|---|');
  for (const s of sources) lines.push(`| journal | \`${cell(s.path)}\` | ${s.rows} |`);
  lines.push('');
  return lines.join('\n') + '\n';
}

function renderRun({ run, totalRows, runCount, generatedAt, commit }) {
  const rows = run.rows;
  const lines = [];

  // ---- header ----
  const first = rows[0];
  const last = rows[rows.length - 1];
  const instance = (rows.find((r) => r.instance_id) || {}).instance_id || null;
  const startedTs = first && first.ts ? first.ts : null;
  const endedTs = last && last.ts ? last.ts : null;

  lines.push('# Last Run');
  lines.push('');
  lines.push(`_Generated ${generatedAt}${commit ? ` · commit \`${commit}\`` : ''}._`);
  lines.push('');
  lines.push(`**Run \`${cell(run.run_id)}\`**${instance ? ` · instance \`${cell(instance)}\`` : ''}`);
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| Run ID | \`${cell(run.run_id)}\` |`);
  if (instance) lines.push(`| Instance | \`${cell(instance)}\` |`);
  lines.push(`| Journal events (this run) | ${rows.length} |`);
  lines.push(`| Started | ${startedTs ? cell(startedTs) : '—'} |`);
  lines.push(`| Last event | ${endedTs ? cell(endedTs) : '—'} |`);
  lines.push(`| Total runs in journal | ${runCount} |`);
  lines.push('');

  // ---- summary counts ----
  const gates = rows.filter(isGate);
  const deploys = rows.filter(isDeploy);
  const halts = rows.filter(isHalt);
  const decisions = rows.filter(isDecision);
  const dispatches = rows.filter(isDispatch);

  lines.push('## Summary');
  lines.push('');
  lines.push('| What | Count |');
  lines.push('|---|---|');
  lines.push(`| Gates fired | ${gates.length} |`);
  lines.push(`| └ script | ${gates.filter((r) => gateRunKind(r) === 'script').length} |`);
  lines.push(`| └ reasoning | ${gates.filter((r) => gateRunKind(r) === 'reasoning').length} |`);
  lines.push(`| Dispatches | ${dispatches.length} |`);
  lines.push(`| Deploys | ${deploys.length} |`);
  lines.push(`| Halts (S-ASK) | ${halts.length} |`);
  lines.push(`| Decisions | ${decisions.length} |`);
  lines.push('');

  // ---- state transitions (the walk) ----
  // Collapse consecutive identical states into a single hop; show each hop's entering action + ts.
  const walk = [];
  let prevState = null;
  for (const r of rows) {
    const st = r.state != null && String(r.state).trim() !== '' ? String(r.state) : null;
    if (st === null) continue;
    if (st !== prevState) {
      walk.push({ state: st, ts: r.ts || null, action: r.action || null });
      prevState = st;
    }
  }
  lines.push('## State transitions');
  lines.push('');
  if (walk.length) {
    lines.push('```');
    lines.push(walk.map((w) => w.state).join('  →  '));
    lines.push('```');
    lines.push('');
    lines.push('| # | State | Entered at | Entering action |');
    lines.push('|---|---|---|---|');
    walk.forEach((w, i) => {
      lines.push(`| ${i + 1} | \`${cell(w.state)}\` | ${w.ts ? cell(w.ts) : '—'} | ${cell(w.action)} |`);
    });
  } else {
    lines.push('_No state values recorded for this run._');
  }
  lines.push('');

  // ---- gates fired ----
  lines.push('## Gates fired');
  lines.push('');
  if (gates.length) {
    lines.push('| Gate | State | Run kind | Outcome | Item | When |');
    lines.push('|---|---|---|---|---|---|');
    for (const r of gates) {
      lines.push(`| \`${cell(r.gate_id)}\` | ${cell(r.state)} | ${gateRunKind(r)} | ${fmtOutcome(r.outcome)} | ${r.item_id ? `\`${cell(r.item_id)}\`` : '—'} | ${r.ts ? cell(r.ts) : '—'} |`);
    }
  } else {
    lines.push('_No gates fired in this run._');
  }
  lines.push('');

  // ---- dispatches ----
  lines.push('## Dispatches');
  lines.push('');
  if (dispatches.length) {
    lines.push('| Action | Item | State | Outcome | When |');
    lines.push('|---|---|---|---|---|');
    for (const r of dispatches) {
      lines.push(`| ${cell(r.action)} | ${r.item_id ? `\`${cell(r.item_id)}\`` : '—'} | ${cell(r.state)} | ${fmtOutcome(r.outcome)} | ${r.ts ? cell(r.ts) : '—'} |`);
    }
  } else {
    lines.push('_No dispatches in this run._');
  }
  lines.push('');

  // ---- deploys ----
  lines.push('## Deploys');
  lines.push('');
  if (deploys.length) {
    lines.push('| Action | Deploy run | State | Outcome | When |');
    lines.push('|---|---|---|---|---|');
    for (const r of deploys) {
      lines.push(`| ${cell(r.action)} | ${r.deploy_run_id ? `\`${cell(r.deploy_run_id)}\`` : '—'} | ${cell(r.state)} | ${fmtOutcome(r.outcome)} | ${r.ts ? cell(r.ts) : '—'} |`);
    }
  } else {
    lines.push('_No deploys in this run._');
  }
  lines.push('');

  // ---- halts ----
  lines.push('## Halts (S-ASK)');
  lines.push('');
  if (halts.length) {
    lines.push('| Halt case | Action | Item | Decision | When |');
    lines.push('|---|---|---|---|---|');
    for (const r of halts) {
      lines.push(`| ${r.halt_case != null && String(r.halt_case).trim() !== '' ? `case ${cell(r.halt_case)}` : '—'} | ${cell(r.action)} | ${r.item_id ? `\`${cell(r.item_id)}\`` : '—'} | ${r.decision_id ? `\`${cell(r.decision_id)}\`` : '—'} | ${r.ts ? cell(r.ts) : '—'} |`);
    }
  } else {
    lines.push('_No halts in this run._');
  }
  lines.push('');

  // ---- decisions ----
  lines.push('## Decisions');
  lines.push('');
  if (decisions.length) {
    lines.push('| Decision | Halt case | Item | Action | When |');
    lines.push('|---|---|---|---|---|');
    for (const r of decisions) {
      lines.push(`| ${r.decision_id ? `\`${cell(r.decision_id)}\`` : '—'} | ${r.halt_case != null && String(r.halt_case).trim() !== '' ? `case ${cell(r.halt_case)}` : '—'} | ${r.item_id ? `\`${cell(r.item_id)}\`` : '—'} | ${cell(r.action)} | ${r.ts ? cell(r.ts) : '—'} |`);
    }
  } else {
    lines.push('_No decisions recorded in this run._');
  }
  lines.push('');

  // ---- budget snapshot (last seen, if any) ----
  const lastBudget = [...rows].reverse().find((r) => r.budget_counters && typeof r.budget_counters === 'object');
  if (lastBudget) {
    lines.push('## Budget counters (last snapshot this run)');
    lines.push('');
    const bc = lastBudget.budget_counters;
    const keys = Object.keys(bc);
    if (keys.length) {
      lines.push('| Counter | Value |');
      lines.push('|---|---|');
      for (const k of keys) lines.push(`| ${cell(k)} | ${cell(bc[k])} |`);
    } else {
      lines.push('_Empty counter snapshot._');
    }
    lines.push('');
  }

  // ---- full event timeline (compact) ----
  lines.push('## Full event timeline');
  lines.push('');
  lines.push('| # | When | State | Action | Gate | Outcome |');
  lines.push('|---|---|---|---|---|---|');
  rows.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.ts ? cell(r.ts) : '—'} | ${cell(r.state)} | ${cell(r.action)} | ${r.gate_id ? `\`${cell(r.gate_id)}\`` : '—'} | ${fmtOutcome(r.outcome)} |`);
  });
  lines.push('');
  lines.push(`> Digest of the most recent of ${runCount} run(s) in the journal (${totalRows} total event rows).`);
  lines.push('');

  return lines.join('\n') + '\n';
}

// ---- main -------------------------------------------------------------------------------------

function main() {
  // A renderer must ALWAYS write a valid artifact and exit 0 — even with a missing/corrupt config
  // seam. readConfigSafe() returns {} (→ candidate-path defaults) instead of exiting the process.
  const cfg = readConfigSafe();

  // Resolve the candidate journal paths for source reporting (independent of whether they exist).
  const sourcePaths = [];
  sourcePaths.push(join(INDEX, 'run_journal.jsonl'));
  const cfgCand = cfgJournalCandidate(cfg);
  if (cfgCand) sourcePaths.push(cfgCand);
  sourcePaths.push(join(INDEX, 'run-journal.jsonl'));
  // De-dup for the source report.
  const seenSrc = new Set();
  const sources = [];
  for (const p of sourcePaths) {
    let key; try { key = resolve(p); } catch { key = p; }
    if (seenSrc.has(key)) continue;
    seenSrc.add(key);
    sources.push({ path: p, rows: readJsonlSafe(p).length });
  }

  const rows = readJournal(cfg);

  // Best-effort current commit for provenance. git-absent → omit (graceful degradation).
  const head = tryGit('rev-parse --short HEAD');
  const commit = head && head.ok ? head.out : null;
  const generatedAt = nowIso();

  let md;
  let latest = null;
  if (!rows.length) {
    md = renderEmpty({ generatedAt, commit, sources });
  } else {
    latest = pickLatestRun(rows);
    if (!latest || !latest.rows.length) {
      md = renderEmpty({ generatedAt, commit, sources });
    } else {
      md = renderRun({
        run: latest,
        totalRows: rows.length,
        runCount: latest.runCount,
        generatedAt,
        commit,
      });
    }
  }

  // Write the single 'out' artifact: HOME/last-run.md. Ensure HOME exists. A write failure is
  // REPORTED (not thrown) and we still exit 0 — a renderer never blocks the loop.
  const outPath = join(HOME, 'last-run.md');
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

  // Renderers report, never block: ALWAYS exit 0. Emit JSON directly (an explicit shape + a
  // possible writeError field), the same pattern as render-readiness.mjs.
  out({
    ok: true,
    out: outPath,
    written,
    ...(writeError ? { writeError } : {}),
    runFound: !!(latest && latest.rows && latest.rows.length),
    runId: latest ? latest.run_id : null,
    runCount: latest ? latest.runCount : 0,
    eventsInRun: latest ? latest.rows.length : 0,
    totalRows: rows.length,
    sources,
  });
  process.exit(0);
}

try {
  main();
} catch (e) {
  // Last-resort guard: the hard rules forbid an unhandled stack trace, and a renderer never blocks.
  // Emit clean JSON and exit 0 (report-only).
  out({ ok: true, written: false, error: `render-last-run degraded: ${e && e.message ? e.message : String(e)}` });
  process.exit(0);
}
