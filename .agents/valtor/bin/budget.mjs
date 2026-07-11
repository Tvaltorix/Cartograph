#!/usr/bin/env node
// budget.mjs — Layer-A item A3 / HALT case 8.
// Per-item effort counters in the 'budget' ledger table. Counts are DERIVED from append-only
// rows (inc + reset markers) so state is rebuildable from git — no running value is stored
// authoritatively; we recompute count on every read by replaying the table.
//
// Usage:  node budget.mjs <inc|check|reset> <counter> [itemId]
//   counter ∈ { retries, debug_iterations, deploy_attempts, gv_retries, no_progress }
//   inc   → append an inc row, recompute count; count > limit → exit 1 {exceeded:true,...} (HALT case 8)
//   check → report current count vs limit WITHOUT mutating the ledger
//   reset → append a reset marker for (itemId,counter); count returns to 0
import { loadConfig, appendRow, readRows, args, ok, fail } from './lib.mjs';

// counter name -> config.budget limit key. The only place this mapping lives.
const COUNTER_LIMIT_KEY = {
  retries: 'perItemMaxRetries',
  debug_iterations: 'perItemDebugIterations',
  deploy_attempts: 'maxDeployAttemptsPerItem',
  gv_retries: 'maxGVRetriesPerItem',
  no_progress: 'maxNoProgressCycles',
};
const VALID_COUNTERS = Object.keys(COUNTER_LIMIT_KEY);
const VALID_ACTIONS = ['inc', 'check', 'reset'];
const TABLE = 'budget';

// Replay the append-only budget rows for one (itemId,counter): an inc row adds 1, a reset
// marker zeroes the running tally. Returns the count of inc rows since the latest reset.
function deriveCount(rows, itemId, counter) {
  let count = 0;
  for (const r of rows) {
    if (!r || r.counter !== counter || r.item_id !== itemId) continue;
    if (r.kind === 'reset') count = 0;
    else if (r.kind === 'inc') count += 1;
  }
  return count;
}

function main() {
  const a = args();
  const action = a[0];
  const counter = a[1];
  // itemId is optional per the README contract; default to a stable sentinel so the
  // (itemId,counter) key is always well-defined and never collides with a real item id.
  const itemId = (a[2] === undefined || a[2] === '') ? '_unscoped' : a[2];

  if (!action || !VALID_ACTIONS.includes(action)) {
    return fail(`usage: budget.mjs <inc|check|reset> <counter> [itemId] — bad action ${action ? `'${action}'` : '(missing)'}`,
      { validActions: VALID_ACTIONS });
  }
  if (!counter || !VALID_COUNTERS.includes(counter)) {
    return fail(`unknown counter ${counter ? `'${counter}'` : '(missing)'}`, { validCounters: VALID_COUNTERS });
  }

  const config = loadConfig(); // exits non-zero on missing/corrupt config
  const budget = (config && config.budget) || {};
  const limitKey = COUNTER_LIMIT_KEY[counter];
  const limit = budget[limitKey];
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return fail(`config.budget.${limitKey} is not a number (got ${JSON.stringify(limit)}) — cannot evaluate counter '${counter}'`,
      { counter, limitKey });
  }
  const onExceed = budget.onExceed || null;

  // readRows degrades gracefully to [] when the table file does not exist yet.
  const rows = readRows(TABLE);
  const before = deriveCount(rows, itemId, counter);

  if (action === 'check') {
    const exceeded = before > limit;
    return ok({ action, counter, itemId, count: before, limit, limitKey, exceeded, onExceed, remaining: Math.max(0, limit - before) });
  }

  if (action === 'reset') {
    appendRow(TABLE, { kind: 'reset', counter, item_id: itemId, prev_count: before });
    return ok({ action, counter, itemId, count: 0, limit, limitKey, onExceed, reset: true });
  }

  // action === 'inc'
  appendRow(TABLE, { kind: 'inc', counter, item_id: itemId });
  // Re-derive from a FRESH read of the committed ledger rather than trusting `before + 1`.
  // appendFileSync is a single atomic append, but another instance may have appended an inc
  // row between our initial read and ours. Counting `before + 1` would undercount in that
  // race and report exceeded=false while the true count is already over the limit — a
  // fail-OPEN on a safety-critical HALT budget. Recomputing from disk fails CLOSED: if a
  // concurrent writer already pushed us over, this caller sees it and halts (HALT case 8).
  // `count` is therefore >= before + 1 (never lower); the +1 floor is preserved if the
  // re-read somehow lags (defensive: cheap monotonicity guard, never decrements our own inc).
  const count = Math.max(before + 1, deriveCount(readRows(TABLE), itemId, counter));
  if (count > limit) {
    // HALT case 8 — effort budget exceeded. Non-zero exit lets a gate block deterministically.
    return fail(`budget exceeded for counter '${counter}' on item '${itemId}'`,
      { exceeded: true, action, counter, itemId, count, limit, limitKey, onExceed, haltCase: 8 });
  }
  return ok({ action, counter, itemId, count, limit, limitKey, onExceed, exceeded: false, remaining: Math.max(0, limit - count) });
}

try {
  main();
} catch (e) {
  // Defensive backstop: never emit an unhandled stack trace; always one JSON object + nonzero exit.
  fail(`unexpected error: ${e && e.message ? e.message : String(e)}`);
}
