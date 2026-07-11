#!/usr/bin/env node
// gate-migration-safety.mjs — Layer-A gate G3b (SCHEMA §4, registry "G3b-migration-safety").
// Owner: valtor-data. Fires at S3 (CLEAR) + S7 (INTEGRATE) when referent_kind==migration.
//
// Reviews ONE migration file for safety before it can ship:
//   (1) DOWN PAIR — a reversible counterpart exists, per config.dataSafety.requireDownMigration:
//         a sibling `<same-number>*.down.sql`, OR an inline DOWN section in the up file
//         (`-- DOWN`, `-- +migrate Down`, `-- migrate:down`, `---- down ----`, etc.).
//   (2) DESTRUCTIVE-ON-REAL-DATA — any DROP TABLE / TRUNCATE / ALTER..DROP COLUMN / DROP SCHEMA
//         / DELETE FROM touching a config.dataSafety.realDataTables table -> HALT (exit 1).
//         These tables hold REAL customer data (sites/clients/regions); a destructive op on
//         them is never auto-safe and must be conferred.
//   (3) COLUMN-ADD BACKFILL — an `ADD COLUMN` on an existing table must declare a default
//         (DEFAULT ...) OR a NOT NULL safe-default OR carry a backfill note in the file
//         (UPDATE ... SET, "backfill", or be nullable-without-default which is itself safe).
//         A NOT NULL add with neither a default nor a backfill is the unsafe case.
//
// Output: {ok, pass, file, checks:[{check, ok, detail}], ...}.
// Exit 1 (BLOCK) on: any destructive-on-real-data op, OR a missing down (when required).
// Exit 0 (PASS) otherwise. The backfill check surfaces in `checks` but, like the registry
// intent, a missing safe-default on a populated table is a fail too (folded into pass).
//
// Graceful degradation (HEADLINE): a missing file, an empty file, an absent config key, an
// absent ledger, or git-absent all produce a clean JSON result + a sensible exit — never a
// stack trace. Run against a fresh repo with no data and it still returns valid JSON.
//
// Usage: node gate-migration-safety.mjs <path/to/migration.sql>
import { readFileSync, readdirSync } from 'node:fs';
import { loadConfig, existsSync, args, out } from './lib.mjs';

const [rawPath] = args();

// --- Defensive arg validation ----------------------------------------------------
if (!rawPath || typeof rawPath !== 'string') {
  // No file to check -> nothing to assert. Print a clean "no-op" result, exit 1 because
  // a gate invoked with no target is a misuse, not a pass (fail-closed on usage).
  out({
    ok: false,
    pass: false,
    error: 'usage: node gate-migration-safety.mjs <path/to/migration.sql>',
    file: null,
    checks: [],
  });
  process.exit(1);
}

// Normalize to forward slashes so sibling-path math + extension checks are cross-platform.
const file = String(rawPath).replace(/\\/g, '/');

// --- Load config (graceful on every missing key) ---------------------------------
const config = loadConfig(); // lib exits non-zero on a missing/corrupt config file itself
const dataSafety = (config && config.dataSafety) || {};
const requireDownMigration = dataSafety.requireDownMigration === true; // default false if absent
const realDataTables = Array.isArray(dataSafety.realDataTables) ? dataSafety.realDataTables : [];

// --- Read the migration body (graceful on missing/empty) --------------------------
let body = '';
let fileExists = false;
if (existsSync(file)) {
  fileExists = true;
  try { body = readFileSync(file, 'utf8'); }
  catch { body = ''; } // unreadable -> treat as empty; checks below degrade, never throw
}

// A `.down.sql` file passed directly IS the down half — there's nothing to reverse for it,
// and its DROP COLUMNs are the legitimate reversal of an additive up. Don't treat a down
// file's own DROPs as destructive-on-real-data, and don't demand a down-of-the-down.
const isDownFile = /\.down\.sql$/i.test(file);

// =================================================================================
// CHECK 1 — paired / inline DOWN migration
// =================================================================================
function checkDownPair() {
  if (!requireDownMigration) {
    return { check: 'down-migration', ok: true, detail: 'config.dataSafety.requireDownMigration not set — skipped' };
  }
  if (isDownFile) {
    return { check: 'down-migration', ok: true, detail: 'target IS a .down.sql file — no down-of-down required' };
  }
  if (!fileExists) {
    // Can't find a sibling reliably if we can't even read the up; report honestly.
    return { check: 'down-migration', ok: false, detail: `migration file not found: ${file}` };
  }

  // (a) Inline DOWN section — common goose/dbmate/sql-migrate/hand-rolled markers.
  const inlineDown = /^\s*--+\s*(\+?\s*migrate\s+down|migrate:\s*down|down\b|---+\s*down)/im.test(body);
  if (inlineDown) {
    return { check: 'down-migration', ok: true, detail: 'inline DOWN section present in up file' };
  }

  // (b) Sibling `<same-number-prefix>*.down.sql` in the same directory.
  //   path: services/sites/migrations/060_sites_archive.sql
  //   sib : services/sites/migrations/060_sites_archive.down.sql  (preferred, exact stem)
  //   also accept any 060*.down.sql in the dir (number-prefix match) for renamed stems.
  const slash = file.lastIndexOf('/');
  const dir = slash >= 0 ? file.slice(0, slash) : '.';
  const base = slash >= 0 ? file.slice(slash + 1) : file;

  // exact-stem sibling: foo.sql -> foo.down.sql
  const exactStem = base.replace(/\.sql$/i, '.down.sql');
  const exactSibling = (dir === '.' ? '' : dir + '/') + exactStem;
  if (existsSync(exactSibling)) {
    return { check: 'down-migration', ok: true, detail: `paired down found: ${exactSibling}` };
  }

  // number-prefix sibling: scan the dir for `<NNN...>*.down.sql` sharing this file's
  // leading numeric token (e.g. "053b", "060", "12"). Directory read is best-effort.
  const numMatch = base.match(/^(\d+[a-z]?)/i);
  if (numMatch) {
    const prefix = numMatch[1].toLowerCase();
    let entries = [];
    try {
      // Best-effort directory read — a missing dir / permission error degrades to no match,
      // never a throw (the exact-stem existsSync check above is the primary path anyway).
      entries = readdirSync(dir === '.' ? '.' : dir);
    } catch { entries = []; }
    const hit = entries.find((e) => {
      const en = String(e).toLowerCase();
      if (!en.endsWith('.down.sql')) return false;
      const m = en.match(/^(\d+[a-z]?)/);
      return m && m[1] === prefix;
    });
    if (hit) {
      return { check: 'down-migration', ok: true, detail: `paired down found (number-prefix ${prefix}): ${hit}` };
    }
  }

  return {
    check: 'down-migration',
    ok: false,
    detail: `no paired down (.down.sql or sibling) and no inline DOWN section for ${base}`,
  };
}

// =================================================================================
// CHECK 2 — destructive op on a real-data table  (HALT)
// =================================================================================
// Strip SQL comments + string literals before pattern-matching so a table name mentioned
// only inside a comment ("-- drops sites.sites someday") or a quoted string never trips a
// false HALT. This is deliberately conservative on the *false-positive* side: we'd rather
// not block a comment, but we DO want every real DDL statement caught.
function stripCommentsAndStrings(sql) {
  let s = String(sql);
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' '); // /* block comments */
  s = s.replace(/--[^\n]*/g, ' ');         // -- line comments
  s = s.replace(/'(?:''|[^'])*'/g, "''");  // 'single-quoted' literals
  s = s.replace(/\$\$[\s\S]*?\$\$/g, ' '); // $$ dollar-quoted bodies (PL/pgSQL) $$
  return s;
}

function checkDestructiveOnRealData() {
  const detail = { tablesChecked: realDataTables.length, hits: [] };

  if (realDataTables.length === 0) {
    return { check: 'no-destructive-on-real-data', ok: true, detail: 'config.dataSafety.realDataTables empty — nothing protected' };
  }
  if (isDownFile) {
    // A down file's DROP COLUMNs are the sanctioned reversal of an additive up. Not a HALT.
    return { check: 'no-destructive-on-real-data', ok: true, detail: 'target is a .down.sql (reversal) — destructive ops are the expected inverse' };
  }
  if (!fileExists || body.trim() === '') {
    return { check: 'no-destructive-on-real-data', ok: true, detail: 'no SQL body to scan (missing/empty file)' };
  }

  const sql = stripCommentsAndStrings(body);

  for (const tableRaw of realDataTables) {
    if (typeof tableRaw !== 'string' || !tableRaw.trim()) continue;
    const table = tableRaw.trim();
    // Accept schema-qualified ("sites.sites") and the bare table name as a fallback. Build
    // a matcher that tolerates optional quoting and arbitrary whitespace/newlines.
    const parts = table.split('.');
    const tName = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    const schema = parts.length > 1 ? parts[0] : null;

    const ident = (name) => `"?${escapeRe(name)}"?`;
    // qualified ("schema"."table" | schema.table) OR bare table. The bare alternative carries
    // a negative lookahead `(?!\s*\.)` so a config entry like "sites.sites" does NOT also match
    // the `sites` SCHEMA prefix of an unrelated `sites.clients` — that cross-table bleed would
    // mis-attribute the HALT (it still HALTs, but on the wrong table). For an unqualified config
    // entry the bare name IS the table, so the same lookahead just prevents matching it as a
    // schema-of-something-else, which is correct too.
    const qualified = schema ? `${ident(schema)}\\s*\\.\\s*${ident(tName)}` : null;
    const bare = `${ident(tName)}(?!\\s*\\.)`;
    const tableRef = schema ? `(?:${qualified}|${bare})` : bare;
    const ws = '[\\s\\n]+';
    const optIfExists = `(?:if${ws}exists${ws})?`;

    const destructivePatterns = [
      { op: 'DROP TABLE',   re: new RegExp(`\\bdrop${ws}table${ws}${optIfExists}${tableRef}`, 'i') },
      { op: 'TRUNCATE',     re: new RegExp(`\\btruncate(?:${ws}table)?${ws}(?:only${ws})?${tableRef}`, 'i') },
      { op: 'DELETE FROM',  re: new RegExp(`\\bdelete${ws}from${ws}(?:only${ws})?${tableRef}`, 'i') },
      // ALTER TABLE <real> ... DROP COLUMN/CONSTRAINT  (DROP appears after the table ref, in the
      // SAME statement). The gap is `[^;]*?` — NOT `[\s\S]*?` — so a later, unrelated DROP in a
      // following statement (e.g. an additive `ALTER..ADD COLUMN` here, then a separate
      // `DROP INDEX ...;`) cannot bleed across the `;` and mis-attribute a HALT to this table.
      { op: 'ALTER..DROP',  re: new RegExp(`\\balter${ws}table${ws}${optIfExists}${tableRef}[^;]*?\\bdrop\\b`, 'i') },
    ];
    // DROP SCHEMA matches the SCHEMA half of a qualified real-data table.
    if (schema) {
      destructivePatterns.push({
        op: 'DROP SCHEMA',
        re: new RegExp(`\\bdrop${ws}schema${ws}${optIfExists}${ident(schema)}\\b`, 'i'),
      });
    }

    for (const { op, re } of destructivePatterns) {
      if (re.test(sql)) detail.hits.push({ table, op });
    }
  }

  const ok = detail.hits.length === 0;
  return {
    check: 'no-destructive-on-real-data',
    ok,
    detail: ok
      ? 'no destructive op on a real-data table'
      : `HALT — destructive op on real-data table(s): ${detail.hits.map((h) => `${h.op} ${h.table}`).join('; ')}`,
    hits: detail.hits,
  };
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// =================================================================================
// CHECK 3 — column-add declares a default / backfill note
// =================================================================================
function checkColumnAddBackfill() {
  if (isDownFile) {
    return { check: 'column-add-backfill', ok: true, detail: 'target is a .down.sql — column-add backfill N/A' };
  }
  if (!fileExists || body.trim() === '') {
    return { check: 'column-add-backfill', ok: true, detail: 'no SQL body to scan (missing/empty file)' };
  }

  const sql = stripCommentsAndStrings(body);

  // Find every ADD COLUMN clause and inspect the column definition up to the next comma /
  // ADD / ALTER / statement terminator. We classify each as safe or needs-backfill.
  const addRe = /\badd\s+column\s+(?:if\s+not\s+exists\s+)?("?[\w]+"?)([\s\S]*?)(?=,\s*add\b|,\s*alter\b|;|\badd\s+column\b|$)/gi;

  // A file-level backfill note (UPDATE ... SET, or the literal word "backfill") satisfies the
  // "declares a backfill" half for ALL adds in the file — common pattern: add nullable, then
  // backfill, then SET NOT NULL in a follow-up statement.
  const fileHasBackfill = /\bupdate\b[\s\S]*?\bset\b/i.test(sql) || /backfill/i.test(body);

  const cols = [];
  let m;
  while ((m = addRe.exec(sql)) !== null) {
    const name = m[1].replace(/"/g, '');
    const defn = m[2] || '';
    const hasDefault = /\bdefault\b/i.test(defn);
    const isNotNull = /\bnot\s+null\b/i.test(defn);
    const isGenerated = /\bgenerated\b/i.test(defn);
    // SAFE if: has a DEFAULT, OR is generated, OR is nullable (no NOT NULL) — a nullable
    // add backfills to NULL with no rewrite risk. UNSAFE only when NOT NULL with no DEFAULT
    // and no file-level backfill note.
    const unsafe = isNotNull && !hasDefault && !isGenerated && !fileHasBackfill;
    cols.push({ name, hasDefault, notNull: isNotNull, generated: isGenerated, unsafe });
  }

  if (cols.length === 0) {
    return { check: 'column-add-backfill', ok: true, detail: 'no ADD COLUMN in this migration' };
  }

  const unsafeCols = cols.filter((c) => c.unsafe);
  if (unsafeCols.length === 0) {
    return {
      check: 'column-add-backfill',
      ok: true,
      detail: `${cols.length} ADD COLUMN — all declare a default / are nullable / have a backfill note`,
      columns: cols.map((c) => c.name),
    };
  }
  return {
    check: 'column-add-backfill',
    ok: false,
    detail: `NOT NULL column add(s) with no DEFAULT and no backfill note: ${unsafeCols.map((c) => c.name).join(', ')}`,
    columns: cols.map((c) => c.name),
    unsafe: unsafeCols.map((c) => c.name),
  };
}

// =================================================================================
// Run all checks, combine, report.
// =================================================================================
const checks = [
  checkDownPair(),
  checkDestructiveOnRealData(),
  checkColumnAddBackfill(),
];

const pass = checks.every((c) => c.ok);

// A destructive-on-real-data hit OR a missing-required-down is a hard BLOCK. The backfill
// check folds into `pass` per the registry intent ("declares a backfill/safe-default").
const result = {
  ok: pass,
  pass,
  file,
  fileExists,
  checks,
};
out(result);
process.exit(pass ? 0 : 1);
