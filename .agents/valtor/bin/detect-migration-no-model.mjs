#!/usr/bin/env node
// detect-migration-no-model.mjs — Layer-A orphan detector "migration-no-model"
// (registry id: migration-no-model; SCHEMA §5 orphan classes + §5b graph projection).
//
//   node detect-migration-no-model.mjs
//
// For every migration matching config.extractors.migrations.glob, extract the
// columns + tables it ADDS, then flag two orphan classes:
//
//   reason:"unreferenced"  — a column or table that NO query string / serde struct
//                            anywhere in the codebase ever names. (Schema with no
//                            model behind it — the migration shipped data the app
//                            can't read.)
//   reason:"no-constraint" — a *domain* column (an enum/range/regex/fk-shaped name
//                            or type) that the migration text adds WITHOUT a paired
//                            DB-level constraint (CHECK / ENUM type / REFERENCES /
//                            UNIQUE / NOT NULL-with-domain). Encodes the locked
//                            project principle: "data stored at the DB level needs
//                            constraints at the DB level — serde is the boundary,
//                            not the column" (CLAUDE.md LOCKED PRINCIPLE 1 / G3).
//
// Also emits `persists_to` edges (migration -> table) to the `edges` ledger so the
// system-map graph (SCHEMA §5b) gets this detector's edge list for free — same pass,
// no second extraction.
//
// DETECTOR CONTRACT: read-only on the working tree (it never Edits/Writes a tree file;
// appending to the `edges` ledger jsonl is the detector's declared output, not a tree
// mutation). It REPORTS, never blocks: it always exits 0, even with findings, even on
// an empty/degraded repo. Graceful degradation is the headline requirement — a glob
// matching nothing, an absent codebase seam, a missing config key, or git-absent each
// yield a clean partial/empty result, never a stack trace.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, relative, sep } from 'node:path';
import {
  loadConfig, appendRow, matchesAny, out, existsSync,
} from './lib.mjs';

// ---------------------------------------------------------------------------
// Small, dependency-free filesystem glob walker. config.extractors.migrations.glob
// is a path glob like "services/*/migrations/*.sql". We resolve it ourselves rather
// than shell out (cross-platform: Windows Git Bash + posix, no `find`/`ls` reliance).
// Returns repo-relative forward-slash paths. Degrades to [] on any walk error.
// ---------------------------------------------------------------------------
function toPosix(p) { return String(p).split(sep).join('/').replace(/\\/g, '/'); }

// Derive the literal directory prefix that contains no glob magic, so we only walk
// the smallest subtree the glob could possibly match (e.g. "services" for
// "services/*/migrations/*.sql"). Falls back to "." (repo root) if the first
// segment already contains a wildcard.
function staticPrefixOf(glob) {
  const segs = toPosix(glob).split('/');
  const stat = [];
  for (const s of segs) {
    if (s.includes('*') || s.includes('?') || s.includes('[')) break;
    stat.push(s);
  }
  // Drop the trailing segment if it's the file pattern itself (no, prefix is dirs only):
  return stat.length ? stat.join('/') : '.';
}

function walkFiles(rootDir, maxFiles = 20000) {
  const found = [];
  if (!existsSync(rootDir)) return found;
  const stack = [rootDir];
  // Skip noisy non-source dirs so a huge repo doesn't blow the file cap on junk.
  const skipDir = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.next', '.agents']);
  while (stack.length && found.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { continue; } // unreadable dir -> skip, never throw
    for (const e of entries) {
      const full = join(dir, e.name);
      let isDir = false;
      try { isDir = e.isDirectory(); } catch { isDir = false; }
      if (isDir) {
        if (!skipDir.has(e.name)) stack.push(full);
      } else {
        found.push(full);
        if (found.length >= maxFiles) break;
      }
    }
  }
  return found;
}

function globFiles(glob) {
  const g = toPosix(glob);
  const prefix = staticPrefixOf(g);
  const root = prefix === '.' ? '.' : prefix;
  const all = walkFiles(root);
  // lib.matchesAny compiles "**" -> ".*" but "**/" still requires the trailing
  // slash, so a glob like "src/**/*.rs" does NOT match a file sitting directly in
  // "src/" (e.g. "src/model.rs") — only files nested >=1 dir deeper. That is the
  // conventional zero-or-more-segments meaning of "**", so we ALSO test each path
  // against a "**/"-collapsed variant ("src/*.rs"). We do this locally rather than
  // touch shared lib.matchesAny. De-dup the patterns so a glob with no "**" is
  // tested once.
  const collapsed = g.replace(/\*\*\//g, '');
  const patterns = collapsed === g ? [g] : [g, collapsed];
  return all
    .map((f) => toPosix(relative('.', f)))
    .filter((rel) => rel && matchesAny(rel, patterns));
}

// ---------------------------------------------------------------------------
// SQL parsing — deliberately conservative regex extraction (we are detecting
// *candidates*, not building a SQL AST). We want zero false NEGATIVES on the
// "unreferenced" axis but tolerate a little noise (a noisy candidate just gets
// cross-checked against the codebase grep, which clears it if referenced).
// ---------------------------------------------------------------------------

// Strip line + block comments and string/dollar-quoted bodies lightly so seed
// INSERT payloads don't masquerade as DDL. Keep it simple + robust.
function stripComments(sql) {
  let s = String(sql);
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');   // block comments
  s = s.replace(/--[^\n]*/g, ' ');           // line comments
  return s;
}

// Quote-strip an identifier: "schema"."table" / schema.table -> bare table name (last segment).
function bareName(id) {
  if (!id) return '';
  const parts = String(id).replace(/"/g, '').split('.');
  return parts[parts.length - 1].trim();
}
function fullName(id) {
  return String(id || '').replace(/"/g, '').trim();
}

// Pull CREATE TABLE [IF NOT EXISTS] <name> ( <body> ) blocks. Returns
// [{ table, fullTable, body }]. Body capture is paren-balanced from the first "(".
function extractCreateTables(sql) {
  const out = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."]+)\s*\(/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const fullTable = fullName(m[1]);
    const table = bareName(m[1]);
    // Balance parens from the "(" we just matched.
    let depth = 0;
    let i = m.index + m[0].length - 1; // points at the "("
    const start = i + 1;
    let end = -1;
    for (; i < sql.length; i++) {
      const c = sql[i];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    const body = end > start ? sql.slice(start, end) : '';
    out.push({ table, fullTable, body });
  }
  return out;
}

// Split a CREATE TABLE body into top-level column/constraint clauses on commas
// that are NOT nested inside parentheses (so CHECK (x IN ('a','b')) stays intact).
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const c of body) {
    if (c === '(') { depth++; cur += c; }
    else if (c === ')') { depth--; cur += c; }
    else if (c === ',' && depth === 0) { parts.push(cur); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// Table-level constraint keywords (a clause that isn't a column definition).
const TABLE_CONSTRAINT_RE = /^(CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|EXCLUDE|LIKE)\b/i;

// Does a single column-definition clause carry an inline DB-level constraint?
// (CHECK / REFERENCES / UNIQUE / PRIMARY KEY / explicit ENUM type / NOT NULL-with-DEFAULT-domain.)
function clauseHasConstraint(clause) {
  const c = clause.toUpperCase();
  if (/\bCHECK\s*\(/.test(c)) return true;
  if (/\bREFERENCES\b/.test(c)) return true;
  if (/\bUNIQUE\b/.test(c)) return true;
  if (/\bPRIMARY\s+KEY\b/.test(c)) return true;
  // A column typed as a real Postgres ENUM type is itself the constraint. We can't
  // know every project enum type name, but the common shapes end in _status/_type/_enum/_kind.
  if (/\b\w+_(STATUS|TYPE|ENUM|KIND|STATE|LEVEL|ROLE|SEVERITY|METHOD|CHANNEL)\b/.test(c)
      && !/\bTEXT\b|\bVARCHAR\b|\bUUID\b|\bINT\b|\bBOOL/.test(c)) return true;
  return false;
}

// "Domain-shaped" column heuristic: a column whose NAME or TYPE implies a bounded
// domain (so per Principle 1 it SHOULD carry a DB constraint). We only raise
// "no-constraint" for these — a free-text narrative column legitimately has none.
function isDomainColumn(colName, clause) {
  const n = String(colName).toLowerCase();
  const c = String(clause).toUpperCase();
  // Name signals a closed/categorical domain or a foreign key.
  if (/(^|_)(status|type|kind|state|level|role|severity|method|channel|outcome)$/.test(n)) return true;
  if (/_id$/.test(n) && !/^id$/.test(n)) return true; // *_id => likely an FK domain
  // Type signals an enum/bounded type even when the name is generic.
  if (/\bBIT\s*\(/.test(c)) return true;             // BIT(168) availability (ADR-0023)
  if (/\b\w+_(STATUS|TYPE|ENUM|KIND|STATE)\b/.test(c)) return true; // real enum type
  return false;
}

// A reserved/known word that is NOT a column name even though it starts a clause.
const NOT_A_COLUMN = new Set([
  'constraint', 'primary', 'foreign', 'unique', 'check', 'exclude', 'like',
]);

// Extract added columns from a CREATE TABLE body. Returns
// [{ column, clause, hasConstraint, domain }].
function columnsFromCreateBody(body) {
  const cols = [];
  for (const clause of splitTopLevel(body)) {
    if (TABLE_CONSTRAINT_RE.test(clause)) continue; // table-level constraint, not a column
    const m = clause.match(/^("?[A-Za-z_][A-Za-z0-9_]*"?)\s+/);
    if (!m) continue;
    const column = bareName(m[1]);
    if (!column || NOT_A_COLUMN.has(column.toLowerCase())) continue;
    cols.push({
      column,
      clause,
      hasConstraint: clauseHasConstraint(clause),
      domain: isDomainColumn(column, clause),
    });
  }
  return cols;
}

// Extract ALTER TABLE ... ADD COLUMN [IF NOT EXISTS] <col> <rest-of-clause-up-to-;>
// Returns [{ table, fullTable, column, clause, hasConstraint, domain }].
function extractAddColumns(sql) {
  const cols = [];
  // Match the ALTER TABLE target then each ADD COLUMN within it. We re-scan the whole
  // file for ADD COLUMN and associate each with the nearest preceding ALTER TABLE target.
  const alterTargets = [];
  const alterRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([A-Za-z0-9_."]+)/gi;
  let am;
  while ((am = alterRe.exec(sql)) !== null) {
    alterTargets.push({ index: am.index, fullTable: fullName(am[1]), table: bareName(am[1]) });
  }
  function tableForIndex(idx) {
    let best = null;
    for (const t of alterTargets) { if (t.index <= idx) best = t; else break; }
    return best || { fullTable: '', table: '' };
  }
  const addRe = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[A-Za-z_][A-Za-z0-9_]*"?)([^,;]*)/gi;
  let cm;
  while ((cm = addRe.exec(sql)) !== null) {
    const column = bareName(cm[1]);
    const clause = (cm[1] + ' ' + (cm[2] || '')).trim();
    const tgt = tableForIndex(cm.index);
    cols.push({
      table: tgt.table,
      fullTable: tgt.fullTable,
      column,
      clause,
      hasConstraint: clauseHasConstraint(clause),
      domain: isDomainColumn(column, clause),
    });
  }
  return cols;
}

// ---------------------------------------------------------------------------
// Codebase reference index — load the source seam ONCE, then test names against it.
// We treat any whole-word appearance of a column/table name in the source corpus as
// "referenced" (a query string, a serde #[sqlx]/struct field, a builder call). This
// is intentionally permissive: the cost of a false "unreferenced" finding is a noisy
// confer item; the cost of a false "referenced" is a missed orphan. We bias to NOT
// crying wolf. snake_case column names rarely collide with English.
// ---------------------------------------------------------------------------
function sourceGlobsFrom(config) {
  // Prefer an explicit broad rust-source seam; fall back through known config seams;
  // finally a sane default. Each is optional — absence just narrows the corpus.
  const ex = (config && config.extractors) || {};
  const globs = [];
  const push = (g) => { if (typeof g === 'string' && g) globs.push(g); };
  // Broadest rust source seam present in this config (eventLockstep.emitter.glob).
  if (ex.eventLockstep && ex.eventLockstep.emitter) push(ex.eventLockstep.emitter.glob);
  if (ex.backendRoutes) push(ex.backendRoutes.glob);
  // Single-file seams (ui call sites, fanout, portal subscriber).
  if (ex.uiCallSites && ex.uiCallSites.file) push(ex.uiCallSites.file);
  if (ex.eventLockstep && typeof ex.eventLockstep.fanout === 'string') push(ex.eventLockstep.fanout);
  if (ex.eventLockstep && typeof ex.eventLockstep.portal === 'string') push(ex.eventLockstep.portal);
  // De-dup; if we somehow have nothing, fall back to all rust + portal source.
  const uniq = [...new Set(globs)];
  return uniq.length ? uniq : ['services/**/*.rs', 'portal/src/**/*.ts', 'portal/src/**/*.tsx'];
}

// Build the searchable source corpus as a single lowercased blob + a word set.
// Returns { wordSet:Set<string>, fileCount, ok:boolean }. Degrades to an empty,
// ok:false corpus if no source files resolve (then we cannot prove "unreferenced",
// so we SUPPRESS unreferenced findings rather than false-flag everything).
function buildSourceIndex(globs) {
  const files = new Set();
  for (const g of globs) {
    if (typeof g !== 'string' || !g) continue;
    // A bare single-file path (no wildcard) resolves directly; else walk-and-match.
    if (!/[*?[]/.test(g)) {
      if (existsSync(g)) {
        try { if (statSync(g).isFile()) files.add(toPosix(g)); } catch { /* skip */ }
      }
      continue;
    }
    for (const f of globFiles(g)) files.add(f);
  }
  const wordSet = new Set();
  let read = 0;
  for (const f of files) {
    let content;
    try { content = readFileSync(f, 'utf8'); } catch { continue; }
    read++;
    // Tokenize on non-identifier chars; snake_case stays whole. Lowercase for match.
    for (const tok of content.toLowerCase().split(/[^a-z0-9_]+/)) {
      if (tok && tok.length > 1) wordSet.add(tok);
    }
  }
  return { wordSet, fileCount: read, ok: read > 0 };
}

function isReferenced(srcIndex, name) {
  if (!srcIndex.ok) return true; // can't prove a negative with no corpus -> assume referenced
  return srcIndex.wordSet.has(String(name).toLowerCase());
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const config = loadConfig(); // exits non-zero only on missing/corrupt config (operational)

  const migGlob = config
    && config.extractors
    && config.extractors.migrations
    && config.extractors.migrations.glob;

  // DEGRADE: no migrations seam configured -> clean empty result, exit 0.
  if (typeof migGlob !== 'string' || !migGlob) {
    out({
      ok: true, detector: 'migration-no-model', degraded: true,
      reason: 'config.extractors.migrations.glob not set',
      migrationsScanned: 0, findings: [], edges: [],
    });
    return process.exit(0);
  }

  const migrationFiles = globFiles(migGlob);

  // DEGRADE: glob matched nothing (fresh repo, no migrations) -> clean empty result.
  if (migrationFiles.length === 0) {
    out({
      ok: true, detector: 'migration-no-model', degraded: true,
      reason: `no files matched migrations glob: ${migGlob}`,
      migrationsScanned: 0, findings: [], edges: [],
    });
    return process.exit(0);
  }

  // Build the codebase reference corpus once.
  const srcIndex = buildSourceIndex(sourceGlobsFrom(config));

  const findings = [];
  const edgeRows = [];
  const seenEdge = new Set();
  // De-dup findings: the same (migration,name,reason) can recur across re-defining
  // migrations; we report each distinct triple once per file.
  const seenFinding = new Set();

  function addFinding(migration, columnOrTable, reason) {
    const key = `${migration}::${columnOrTable}::${reason}`;
    if (seenFinding.has(key)) return;
    seenFinding.add(key);
    findings.push({ migration, column_or_table: columnOrTable, reason });
  }

  function addEdge(migration, table, fullTable) {
    if (!table) return;
    const key = `${migration}->${fullTable || table}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edgeRows.push({ migration, table: fullTable || table });
  }

  for (const file of migrationFiles) {
    let raw;
    try { raw = readFileSync(file, 'utf8'); }
    catch { continue; } // unreadable migration -> skip, never throw
    const migName = basename(file);
    const sql = stripComments(raw);

    // --- CREATE TABLE: new table + its inline columns ---
    const creates = extractCreateTables(sql);
    for (const t of creates) {
      // persists_to edge: this migration persists the table into the schema graph.
      addEdge(migName, t.table, t.fullTable);

      // Table-level "unreferenced": the table name appears nowhere in source.
      if (!isReferenced(srcIndex, t.table)) {
        addFinding(migName, t.fullTable || t.table, 'unreferenced');
      }
      // Column-level checks for the table's own columns.
      for (const col of columnsFromCreateBody(t.body)) {
        if (!isReferenced(srcIndex, col.column)) {
          addFinding(migName, `${t.fullTable || t.table}.${col.column}`, 'unreferenced');
        }
        if (col.domain && !col.hasConstraint) {
          addFinding(migName, `${t.fullTable || t.table}.${col.column}`, 'no-constraint');
        }
      }
    }

    // --- ALTER TABLE ... ADD COLUMN: columns bolted onto an existing table ---
    for (const col of extractAddColumns(sql)) {
      const tableLabel = col.fullTable || col.table || '(unknown-table)';
      // The altered table is persisted-to by this migration too.
      if (col.table) addEdge(migName, col.table, col.fullTable);
      const colLabel = `${tableLabel}.${col.column}`;
      if (!isReferenced(srcIndex, col.column)) {
        addFinding(migName, colLabel, 'unreferenced');
      }
      if (col.domain && !col.hasConstraint) {
        addFinding(migName, colLabel, 'no-constraint');
      }
    }
  }

  // Persist the persists_to edges to the `edges` ledger (the detector's declared
  // output per registry emitsEdges:true; this is a ledger write, not a tree edit).
  // SCHEMA §3.1 edges shape: { from, from_kind, to, to_kind, edge, source_extractor, last_seen_commit }.
  let edgesWritten = 0;
  for (const e of edgeRows) {
    try {
      appendRow('edges', {
        from: e.migration,
        from_kind: 'migration',
        to: e.table,
        to_kind: 'table',
        edge: 'persists_to',
        source_extractor: 'migration-no-model',
        last_seen_commit: null,
      });
      edgesWritten++;
    } catch {
      // A ledger append failure must not abort the report; surface count drift only.
    }
  }

  out({
    ok: true,
    detector: 'migration-no-model',
    degraded: !srcIndex.ok, // no source corpus => unreferenced suppressed (partial)
    sourceCorpus: { files: srcIndex.fileCount, proven: srcIndex.ok },
    migrationsScanned: migrationFiles.length,
    findings,
    findingCount: findings.length,
    edges: edgeRows.map((e) => ({ from: e.migration, to: e.table, edge: 'persists_to' })),
    edgesWritten,
  });
  // REPORT, never block: exit 0 even with findings.
  return process.exit(0);
}

main();
