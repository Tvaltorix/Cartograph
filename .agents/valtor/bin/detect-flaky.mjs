#!/usr/bin/env node
// detect-flaky.mjs — Layer-A detector (registry detectors[].id = "flaky-criterion", SWEEP/S9).
//
//   node detect-flaky.mjs
//
// Scans the append-only `gate_results` + `failures` ledger tables. For each distinct
// (item_id, criterion-or-gate) key it replays the chronologically-ordered pass/fail
// signal and counts how many times the verdict FLIPPED (pass↔fail). A key with >1 flip
// is FLAKY — it has oscillated rather than settled. Prints:
//   { findings: [ { item_id, criterion_or_gate, flips } ] }   sorted most-flaky first.
//
// Per SCHEMA §5 + the registry intent, this is a DETECTOR: read-only, SURFACES findings,
// NEVER blocks. Exit is always 0 (even on operational degradation) — a detector reporting
// "I found nothing" and a detector reporting "I couldn't read the ledger" are both
// non-fatal information, not gate blocks. The only thing it must never do is throw.
//
// Source mapping (the two tables carry pass/fail differently — both reduce to a verdict):
//   gate_results.outcome — "pass" | "fail" | "halt" | "surfaced" | "skipped-codify-pending"
//       → only "pass"/"fail" are flip-relevant verdicts; the criterion axis is `gate_id`.
//   failures.status      — "open" | "workaround" | "fixed" | "flaky"
//       → "fixed" reads as a pass-equivalent (the failure went away), "open" as a
//         fail-equivalent (the failure is live). "workaround"/"flaky" are neither a clean
//         pass nor a clean fail, so they DON'T count as a verdict (they break the chain
//         without registering a flip). The criterion axis here is also `gate_id`.
//
// GRACEFUL DEGRADATION is the headline requirement: absent tables, an empty ledger, rows
// missing fields, corrupt JSON, a fresh repo — all yield a clean { findings: [] } + exit 0.

import { INDEX, args, ok } from './lib.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// A flip is a verdict change. >1 flip means the criterion oscillated more than once.
const FLAKY_THRESHOLD = 1; // strictly greater than this many flips ⇒ flaky

// Read one ledger table directly off disk (rather than lib.readRows) because readRows()
// calls fail() — and thus process.exit(1) — on a single corrupt row. A detector must
// survive a partially-corrupt ledger: skip the unparseable lines, keep the good ones,
// never exit non-zero. Returns { rows, skipped } and never throws.
function readTableLenient(table) {
  const out = { rows: [], skipped: 0 };
  let p;
  try {
    p = join(INDEX, `${table}.jsonl`);
  } catch {
    return out; // INDEX malformed (shouldn't happen) — degrade to empty.
  }
  try {
    if (!existsSync(p)) return out; // absent table — fresh repo / never written.
  } catch {
    return out;
  }
  let text;
  try {
    text = readFileSync(p, 'utf8');
  } catch {
    return out; // unreadable (perms, race) — degrade to empty, not a crash.
  }
  const lines = String(text).split('\n');
  for (const line of lines) {
    if (!line || !line.trim()) continue; // blank line — skip silently.
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') out.rows.push(row);
      else out.skipped += 1; // a bare scalar / null is not a usable row.
    } catch {
      out.skipped += 1; // corrupt JSON line — count it, keep going.
    }
  }
  return out;
}

// Map a gate_results row to { key, verdict, ts } or null if it carries no flip-relevant
// verdict / no usable axis. verdict ∈ { 'pass', 'fail' }.
function eventFromGateResult(row) {
  const itemId = typeof row.item_id === 'string' ? row.item_id : null;
  const gate = typeof row.gate_id === 'string' ? row.gate_id : null;
  if (itemId === null || gate === null) return null; // can't key it.
  let verdict = null;
  if (row.outcome === 'pass') verdict = 'pass';
  else if (row.outcome === 'fail') verdict = 'fail';
  else return null; // halt/surfaced/skipped/etc. — not a clean pass/fail verdict.
  return { item_id: itemId, criterion_or_gate: gate, verdict, ts: tsKey(row) };
}

// Map a failures row to { key, verdict, ts } or null. "fixed" ⇒ pass-equivalent (failure
// resolved), "open" ⇒ fail-equivalent (failure live). Other statuses are not verdicts.
function eventFromFailure(row) {
  const itemId = typeof row.item_id === 'string' ? row.item_id : null;
  const gate = typeof row.gate_id === 'string' ? row.gate_id : null;
  if (itemId === null || gate === null) return null;
  let verdict = null;
  if (row.status === 'fixed') verdict = 'pass';
  else if (row.status === 'open') verdict = 'fail';
  else return null; // workaround / flaky / unknown — break chain, no verdict.
  return { item_id: itemId, criterion_or_gate: gate, verdict, ts: tsKey(row) };
}

// Stable chronological sort key. Prefer `ts` (lib stamps every appended row with one),
// fall back to other timestamp-ish fields, else empty string (preserves append order via
// the stable index tiebreaker below). Never throws on a non-string/absent value.
function tsKey(row) {
  const cand = row.ts ?? row.last_seen ?? row.first_seen ?? row.answered_at;
  return typeof cand === 'string' ? cand : '';
}

function main() {
  // No required args; tolerate (and ignore) anything passed so the CLI never errors on extras.
  void args();

  // Collect verdict events from both tables, tagged with original append order so the sort
  // is stable when two rows share a ts (jsonl append order is the true tiebreaker).
  const events = [];
  let order = 0;

  const gr = readTableLenient('gate_results');
  for (const row of gr.rows) {
    const e = eventFromGateResult(row);
    if (e) events.push({ ...e, _order: order });
    order += 1;
  }

  const fl = readTableLenient('failures');
  for (const row of fl.rows) {
    const e = eventFromFailure(row);
    if (e) events.push({ ...e, _order: order });
    order += 1;
  }

  // Bucket events by (item_id, criterion_or_gate). Use a delimiter that can't appear in a
  // UUID/gate-id; also keep the structured parts so we don't have to re-split the key.
  const buckets = new Map();
  for (const e of events) {
    const key = `${e.item_id}::${e.criterion_or_gate}`;
    if (!buckets.has(key)) {
      buckets.set(key, { item_id: e.item_id, criterion_or_gate: e.criterion_or_gate, events: [] });
    }
    buckets.get(key).events.push(e);
  }

  const findings = [];
  for (const bucket of buckets.values()) {
    // Chronological order; stable tiebreak on original append order.
    bucket.events.sort((a, b) => {
      if (a.ts < b.ts) return -1;
      if (a.ts > b.ts) return 1;
      return a._order - b._order;
    });
    // Count verdict changes across the ordered sequence. Consecutive identical verdicts
    // (pass,pass or fail,fail) are NOT flips; only pass→fail / fail→pass transitions are.
    let flips = 0;
    let prev = null;
    for (const e of bucket.events) {
      if (prev !== null && e.verdict !== prev) flips += 1;
      prev = e.verdict;
    }
    if (flips > FLAKY_THRESHOLD) {
      findings.push({
        item_id: bucket.item_id,
        criterion_or_gate: bucket.criterion_or_gate,
        flips,
      });
    }
  }

  // Most-flaky first; stable secondary sort by item then criterion for deterministic output.
  findings.sort((a, b) => {
    if (b.flips !== a.flips) return b.flips - a.flips;
    if (a.item_id !== b.item_id) return a.item_id < b.item_id ? -1 : 1;
    if (a.criterion_or_gate !== b.criterion_or_gate) return a.criterion_or_gate < b.criterion_or_gate ? -1 : 1;
    return 0;
  });

  // Surface skipped (corrupt/unusable) line counts only when nonzero, so an honest ledger
  // reports nothing extra but a degraded one is visible. Detector still exits 0 regardless.
  const skipped = gr.skipped + fl.skipped;
  const result = { findings };
  if (skipped > 0) result.skippedRows = skipped;
  return ok(result);
}

try {
  main();
} catch (e) {
  // Absolute backstop: a detector NEVER throws and NEVER blocks. Any unforeseen error still
  // produces a single clean JSON object on stdout and exit 0 (surfaces only, per SCHEMA §5).
  ok({ findings: [], error: `degraded: ${e && e.message ? e.message : String(e)}` });
}
