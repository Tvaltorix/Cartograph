#!/usr/bin/env node
// scope-check.mjs — Layer-A gate G-scope (SCHEMA §4, S6 RECONCILE-OUT).
// Assert a worker's touched files stayed inside the item's declared scope:
//   touched ⊆ item.scope_files  AND  touched ∉ config.conflictZones.paths  AND  touched ∉ item.readonly_files
// Any violation is an ESCAPE. Prints {ok, escapes:[{file,reason}]}; exit 1 if any escape (gate block), 0 if clean.
//
// Usage: node scope-check.mjs <itemId> <file1,file2,...>
//
// Fail-closed: an item with no declared scope_files makes EVERY touched file an escape — an undeclared-scope
// worker diff must never silently pass the gate.
import { loadConfig, readRows, matchesAny, args, out, fail } from './lib.mjs';

const [itemId, fileCsv] = args();

// --- Defensive arg validation ---------------------------------------------------
if (!itemId || typeof itemId !== 'string') {
  fail('usage: node scope-check.mjs <itemId> <comma,separated,files>', { missing: 'itemId' });
}
if (fileCsv === undefined) {
  fail('usage: node scope-check.mjs <itemId> <comma,separated,files>', { missing: 'files' });
}

// Split the CSV, normalize backslashes -> forward slashes, drop blanks/dupes.
const touched = [...new Set(
  String(fileCsv)
    .split(',')
    .map((f) => f.trim().replace(/\\/g, '/'))
    .filter(Boolean)
)];

if (touched.length === 0) {
  // Nothing touched -> nothing can escape. A no-op diff is trivially in-scope.
  out({ ok: true, item: itemId, escapes: [] });
  process.exit(0);
}

// --- Load config (conflict zones) + the item -------------------------------------
const config = loadConfig(); // exits non-zero on missing/parse-error
const conflictZones = (config && config.conflictZones && config.conflictZones.paths) || [];

const items = readRows('items'); // [] if the ledger is empty/absent — graceful
const item = items.find((r) => r && r.id === itemId);
if (!item) {
  fail(`item not found in 'items' ledger: ${itemId}`, { item: itemId, knownCount: items.length });
}

// Coerce a pattern list from the ledger/config into clean string globs. These lists are
// worker- and config-authored JSON: a non-string entry (number, null, object) makes lib's
// globToRegex throw `.replace is not a function`, which here would be an UNHANDLED stack
// trace on stdout — both a contract violation (must print one JSON object) and a fail-OPEN
// hazard if the throw fires AFTER a file already cleared the scope test. Keep only non-empty
// strings; record dropped entries so a malformed list is visible, not silently narrowed.
function cleanGlobs(list, label) {
  if (!Array.isArray(list)) return { globs: [], dropped: 0, label, wasArray: false };
  let dropped = 0;
  const globs = [];
  for (const g of list) {
    if (typeof g === 'string' && g.length > 0) globs.push(g);
    else dropped += 1;
  }
  return { globs, dropped, label, wasArray: true };
}

const scope = cleanGlobs(item.scope_files, 'item.scope_files');
const readonly = cleanGlobs(item.readonly_files, 'item.readonly_files');
const zones = cleanGlobs(conflictZones, 'config.conflictZones.paths');

// matchesAny itself can only throw on a malformed entry; cleanGlobs has removed those, so a
// thin guard here is belt-and-suspenders against any future lib change — still fail-closed.
function safeMatch(file, patterns) {
  try { return matchesAny(file, patterns); }
  catch { return false; }
}

// Surface dropped (malformed) glob entries so the gate result is honest about a bad ledger/
// config — a non-string scope glob can't protect anything, so callers should see it.
const malformedGlobs = [scope, readonly, zones]
  .filter((c) => c.dropped > 0)
  .map((c) => ({ list: c.label, droppedEntries: c.dropped }));

// --- Evaluate each touched file --------------------------------------------------
const escapes = [];

// Fail-closed: no declared scope (absent, non-array, or all entries malformed/empty) means we
// cannot prove anything is in-bounds — every touched file is an escape.
const noDeclaredScope = scope.globs.length === 0;

for (const file of touched) {
  if (noDeclaredScope) {
    escapes.push({ file, reason: 'no declared scope (item.scope_files empty/invalid) — fail closed' });
    continue;
  }
  // Order: an in-scope file can still be barred by a conflict-zone or readonly match.
  if (!safeMatch(file, scope.globs)) {
    escapes.push({ file, reason: 'outside item.scope_files' });
    continue;
  }
  if (safeMatch(file, zones.globs)) {
    escapes.push({ file, reason: 'in config.conflictZones.paths (orchestrator-only edit)' });
    continue;
  }
  if (safeMatch(file, readonly.globs)) {
    escapes.push({ file, reason: 'in item.readonly_files (read-only)' });
    continue;
  }
}

const clean = escapes.length === 0;
const result = { ok: clean, item: itemId, checked: touched.length, escapes };
if (malformedGlobs.length > 0) result.malformedGlobs = malformedGlobs;
out(result);
process.exit(clean ? 0 : 1);
