#!/usr/bin/env node
// index-rebuild.mjs — Layer-A item A7: integrity check + re-entry self-check.
//
// `node index-rebuild.mjs`
//   For each TABLES entry: ensure the *.jsonl file exists (create empty if missing — NEVER
//   delete or truncate), verify every non-blank line parses as JSON (report corrupt line
//   numbers; leave corrupt lines untouched). Build {tables:{name:count}} of parsed rows.
//   Resume hint: from 'items', surface those with status in (open,in_progress,debugging);
//   if status_transitions lets us derive a pipeline position, pick the lowest incomplete
//   state, else report the open items. SQLite rebuild is out of scope for the reference impl.
//
// Source of truth is the jsonl ledger (SCHEMA §8). The SQLite index is a derived accelerator,
// so this script reasons entirely off the committed *.jsonl and degrades gracefully when files
// are missing, empty, or partially corrupt — it never throws an unhandled stack trace.

import { INDEX, TABLES, tablePath, ok, fail } from './lib.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// The labeled Valtor state machine (SCHEMA §2), lowest → highest. Used to derive the resume
// point from status_transitions when present.
const PIPELINE_STATES = [
  'INGEST', 'RECONCILE', 'DECOMPOSE', 'CLEAR', 'PLAN-WAVES', 'DISPATCH',
  'RECONCILE-OUT', 'INTEGRATE', 'DEPLOY', 'SWEEP', 'PROPAGATE', 'DONE',
];

// Statuses that mean "still has work left on it" (SCHEMA §3 LoopItem.status).
const INCOMPLETE_ITEM_STATUSES = new Set(['open', 'in_progress', 'debugging']);

// Read a jsonl table file defensively. Returns parsed rows + the line numbers (1-based) that
// failed to parse. Does NOT use lib.readRows() because that fails-fast (process.exit) on the
// first corrupt row — here we must survey ALL corruption without aborting, and without mutating
// the file. Blank lines are ignored (trailing newline is normal).
function surveyTable(table) {
  const p = tablePath(table);
  let created = false;
  if (!existsSync(p)) {
    // Ensure index dir, then create an empty ledger file. Empty-but-present is the valid
    // bootstrapped state (mirrors init.mjs). Never overwrite an existing file.
    try {
      if (!existsSync(INDEX)) mkdirSync(INDEX, { recursive: true });
      writeFileSync(p, '', { flag: 'wx' }); // wx => fail if it raced into existence; don't clobber
      created = true;
    } catch (e) {
      // If another instance created it between the check and the write, that's fine — re-read it.
      if (!existsSync(p)) return { error: `cannot create ${table}.jsonl: ${e.message}` };
    }
  }

  let raw;
  try { raw = readFileSync(p, 'utf8'); }
  catch (e) { return { error: `cannot read ${table}.jsonl: ${e.message}` }; }

  const rows = [];
  const corruptLines = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue; // skip blank / trailing-newline lines
    try { rows.push(JSON.parse(line)); }
    catch { corruptLines.push(i + 1); } // 1-based line number; leave the bad line in place
  }
  return { created, count: rows.length, corruptLines, rows };
}

// Derive a resume hint. Prefer the lowest incomplete pipeline state from status_transitions;
// otherwise fall back to the list of open/in_progress/debugging items.
function deriveResumeHint(itemSurvey, transitionSurvey) {
  const openItems = (itemSurvey.rows || [])
    .filter((r) => r && INCOMPLETE_ITEM_STATUSES.has(r.status))
    .map((r) => ({ id: r.id ?? null, status: r.status ?? null, goal: r.goal ?? null }));

  // Try to derive a pipeline position from status_transitions. Each row carries to_status; we
  // treat any to_status that names a pipeline state as a visited state, and the lowest pipeline
  // state NOT yet reached as the resume target. This is best-effort: the transition ledger may
  // log item-status changes (open→done) rather than pipeline states, in which case nothing maps
  // and we fall back to the open-items list.
  const transitions = transitionSurvey.rows || [];
  const reached = new Set();
  for (const t of transitions) {
    if (!t) continue;
    for (const v of [t.to_status, t.from_status, t.state]) {
      if (typeof v === 'string' && PIPELINE_STATES.includes(v)) reached.add(v);
    }
  }

  let lowestIncompleteState = null;
  if (reached.size > 0) {
    // DONE reached on its own doesn't mean the whole plan is done; report the first state never
    // reached. If every state is reached, the plan walked the full pipeline at least once.
    lowestIncompleteState = PIPELINE_STATES.find((s) => !reached.has(s)) ?? null;
  }

  if (lowestIncompleteState) {
    return {
      basis: 'status_transitions',
      lowestIncompleteState,
      reachedStates: PIPELINE_STATES.filter((s) => reached.has(s)),
      openItems,
    };
  }
  return {
    basis: openItems.length ? 'open-items' : 'none',
    lowestIncompleteState: null,
    openItems,
  };
}

function main() {
  // Guard the table list — a malformed lib import would otherwise throw deep in the loop.
  if (!Array.isArray(TABLES) || TABLES.length === 0) {
    return fail('TABLES is empty or unavailable from lib.mjs — cannot run integrity check');
  }

  const tables = {};
  const corrupt = {}; // table -> [lineNumbers]
  const created = [];
  const readErrors = {}; // table -> message
  let itemSurvey = { rows: [] };
  let transitionSurvey = { rows: [] };

  for (const table of TABLES) {
    const survey = surveyTable(table);
    if (survey.error) {
      readErrors[table] = survey.error;
      tables[table] = null; // count unknown — surface as a read error, not a silent 0
      continue;
    }
    tables[table] = survey.count;
    if (survey.created) created.push(table);
    if (survey.corruptLines.length) corrupt[table] = survey.corruptLines;
    if (table === 'items') itemSurvey = survey;
    if (table === 'status_transitions') transitionSurvey = survey;
  }

  const hasCorruption = Object.keys(corrupt).length > 0;
  const hasReadError = Object.keys(readErrors).length > 0;
  const integrity = hasCorruption || hasReadError ? 'corrupt' : 'ok';

  const resume = deriveResumeHint(itemSurvey, transitionSurvey);

  const payload = {
    tables,
    integrity,
    openItems: resume.openItems,
    resumeHint: {
      basis: resume.basis,
      lowestIncompleteState: resume.lowestIncompleteState,
      ...(resume.reachedStates ? { reachedStates: resume.reachedStates } : {}),
    },
    sqlite: 'skipped (jsonl is source of truth)',
    ...(created.length ? { created } : {}),
    ...(hasCorruption ? { corrupt } : {}),
    ...(hasReadError ? { readErrors } : {}),
  };

  // Exit 0 only when integrity is clean; corruption/read failure is a non-zero gate block so a
  // caller can branch on the exit code without parsing JSON.
  if (integrity === 'ok') return ok(payload);
  return fail('ledger integrity check found corrupt or unreadable rows', payload);
}

try {
  main();
} catch (e) {
  // Last-resort guard: the hard rules forbid an unhandled stack trace. Anything that escaped the
  // per-table try/catch surfaces here as clean JSON + non-zero exit.
  fail(`unexpected error during index-rebuild: ${e && e.message ? e.message : String(e)}`);
}
