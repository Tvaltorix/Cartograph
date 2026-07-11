#!/usr/bin/env node
// gate-db-constraint.mjs — Layer-A gate G3 (SCHEMA §4; fires at S3 CLEAR + S7 INTEGRATE).
//
// LOCKED PRINCIPLE 1 (CLAUDE.md): "Data stored at the DB level needs constraints at the DB
// level — Rust serde defends the boundary, not the column." For every column with a *domain*
// (an enum, a regex/format, a numeric range, or a foreign-key relationship) this gate asserts
// the migration text carries a paired DB-level constraint:
//   CREATE TYPE ... AS ENUM   |   CHECK (...)   |   FOREIGN KEY / REFERENCES   |   UNIQUE   |   GENERATED
//
// Usage:
//   node gate-db-constraint.mjs <migration-file.sql>   # check that file
//   node gate-db-constraint.mjs                         # check the latest migration (by name sort)
//
// Output: { ok, pass, file, findings:[{column, table, type?, domain, hasConstraint, needed, evidence?}], ... }
// Exit 0 = pass (every domain column has a constraint, or there are no domain columns).
// Exit 1 = block (>=1 domain column lacks a paired constraint).
//
// HEURISTIC + CONSERVATIVE (fail-toward-surface): the SQL parse here is regex-based, not a real
// PostgreSQL grammar. When the parser cannot PROVE a constraint is present for a domain column,
// it flags the column for human review rather than passing silently. A false flag costs a glance;
// a false pass lets unconstrained domain data into the DB — exactly what Principle 1 forbids.
//
// GRACEFUL DEGRADATION: no arg + empty/absent migrations dir, an unreadable/empty file, a file
// with zero column definitions, or git-absent all produce a clean {ok:true, pass:true} empty
// result and exit 0 — never a stack trace. A fresh repo runs this without error.

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { loadConfig, args, out } from './lib.mjs';

// ---------------------------------------------------------------------------------------------
// 0. Resolve the target migration file (explicit arg, else latest under the configured glob).
// ---------------------------------------------------------------------------------------------

const [argFile] = args();

// Pull the migrations glob from config (single per-repo seam). Two keys may carry it; prefer the
// dedicated principle block, fall back to extractors, then a last-resort default. Never hardcode
// a repo path as the *primary* source.
function migrationsGlobFromConfig(cfg) {
  const fromPrinciple = cfg && cfg.dbConstraintPrinciple && cfg.dbConstraintPrinciple.migrationsGlob;
  const fromExtractor = cfg && cfg.extractors && cfg.extractors.migrations && cfg.extractors.migrations.glob;
  return fromPrinciple || fromExtractor || 'services/*/migrations/*.sql';
}

// Expand a simple "<root>/*/<sub>/*.sql"-style glob WITHOUT shelling out (cross-platform, no deps).
// Supports a single '*' segment in the directory path + a trailing '*.ext' file pattern, which is
// all the configured globs use. Anything fancier degrades to "no expansion" -> empty list (graceful).
function expandMigrationGlob(glob) {
  const norm = String(glob).replace(/\\/g, '/');
  const parts = norm.split('/');
  // Walk the path segment by segment, expanding a single '*' directory wildcard by listdir.
  let dirs = ['.'];
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i];
    if (seg === '' || seg === '.') continue;
    const next = [];
    for (const d of dirs) {
      const full = d === '.' ? '.' : d;
      if (seg === '*') {
        let entries = [];
        try { entries = readdirSync(full, { withFileTypes: true }); } catch { entries = []; }
        for (const e of entries) {
          if (e.isDirectory()) next.push(d === '.' ? e.name : join(d, e.name));
        }
      } else if (seg.includes('*')) {
        // partial wildcard in a dir segment (e.g. "*-rs") — match by regex
        const re = segGlobToRegex(seg);
        let entries = [];
        try { entries = readdirSync(full, { withFileTypes: true }); } catch { entries = []; }
        for (const e of entries) {
          if (e.isDirectory() && re.test(e.name)) next.push(d === '.' ? e.name : join(d, e.name));
        }
      } else {
        const cand = d === '.' ? seg : join(d, seg);
        try { if (statSync(cand).isDirectory()) next.push(cand); } catch { /* missing dir -> skip */ }
      }
    }
    dirs = next;
  }
  // Last segment is the file pattern (e.g. "*.sql").
  const filePat = parts[parts.length - 1] || '*.sql';
  const fileRe = segGlobToRegex(filePat);
  const files = [];
  for (const d of dirs) {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { entries = []; }
    for (const e of entries) {
      if (e.isFile() && fileRe.test(e.name)) files.push(d === '.' ? e.name : join(d, e.name));
    }
  }
  return files.map((f) => f.replace(/\\/g, '/'));
}

// Glob a single path/file SEGMENT (no '/'): '*' -> any run of non-'/' chars.
function segGlobToRegex(seg) {
  const re = String(seg).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp('^' + re + '$');
}

// "Latest" migration = highest-sorting basename, EXCLUDING *.down.sql (a down-pair is not a
// migration to constrain — it reverses one). Numeric-aware sort so 010 > 009 and 053b > 053a.
function pickLatest(files) {
  const ups = files.filter((f) => !/\.down\.sql$/i.test(basename(f)));
  if (ups.length === 0) return null;
  return ups.sort((a, b) => migrationKey(basename(a)).localeCompare(migrationKey(basename(b)), undefined, { numeric: true, sensitivity: 'base' })).pop();
}
function migrationKey(name) { return name; }

const config = loadConfig(); // exits non-zero on missing/parse-error (a genuinely broken seam)

let targetFile = null;
let resolvedBy = null;

if (argFile) {
  targetFile = String(argFile).replace(/\\/g, '/');
  resolvedBy = 'arg';
} else {
  const glob = migrationsGlobFromConfig(config);
  let files = [];
  try { files = expandMigrationGlob(glob); } catch { files = []; }
  const latest = pickLatest(files);
  if (latest) { targetFile = latest; resolvedBy = 'latest-of-glob'; }
}

// No target resolvable (fresh repo, empty migrations dir, glob matched nothing) -> clean pass.
if (!targetFile) {
  out({ ok: true, pass: true, file: null, resolvedBy: 'none', reason: 'no migration file to check (empty/absent migrations) — nothing to constrain', findings: [], domainColumns: 0 });
  process.exit(0);
}

// A down-migration is never the thing we gate (it reverses a forward migration). Treat as a clean
// no-op rather than a confusing finding set.
if (/\.down\.sql$/i.test(basename(targetFile))) {
  out({ ok: true, pass: true, file: targetFile, resolvedBy, reason: 'down-migration — reverses a forward migration; nothing to constrain', findings: [], domainColumns: 0 });
  process.exit(0);
}

// Read the file defensively (missing/unreadable -> clean empty result, not a throw).
let sqlRaw = '';
if (!existsSync(targetFile)) {
  out({ ok: true, pass: true, file: targetFile, resolvedBy, reason: 'file does not exist — nothing to check', findings: [], domainColumns: 0 });
  process.exit(0);
}
try { sqlRaw = readFileSync(targetFile, 'utf8'); }
catch (e) {
  out({ ok: true, pass: true, file: targetFile, resolvedBy, reason: `file unreadable (${e && e.message}) — degraded to empty`, findings: [], domainColumns: 0 });
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// 1. Strip comments + string literals so they can't fake-match a keyword or hide one.
//    (A column literally named in a comment must not register as a domain column; an "ENUM"
//     mentioned in prose must not satisfy the gate.)
// ---------------------------------------------------------------------------------------------

function stripComments(sql) {
  let s = String(sql);
  // Line comments: -- to EOL.
  s = s.replace(/--[^\n]*/g, ' ');
  // Block comments: /* ... */ (non-greedy, across lines).
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return s;
}

// Replace single-quoted string literals with a neutral placeholder (keep dollar-quoted plpgsql
// bodies intact-ish but neutralize quotes inside). We keep $$...$$ blocks because CREATE TRIGGER /
// function bodies live there, but we DON'T parse columns from them. For the literal-blanking we
// only target '...' which is where enum members + defaults live.
function blankStringLiterals(sql) {
  // ''-escaped quotes handled by consuming pairs first.
  return String(sql).replace(/'(?:[^']|'')*'/g, "''");
}

const sqlNoComments = stripComments(sqlRaw);
const sql = blankStringLiterals(sqlNoComments);

// ---------------------------------------------------------------------------------------------
// 2. Catalog the ENUM types defined in THIS migration (a column of such a type is constrained
//    by the type itself — the strongest DB-level domain there is).
// ---------------------------------------------------------------------------------------------

// CREATE TYPE [schema.]name AS ENUM ( ... )
const enumTypeNames = new Set();
{
  const re = /CREATE\s+TYPE\s+([A-Za-z_][\w.]*)\s+AS\s+ENUM/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const full = m[1];
    enumTypeNames.add(full.toLowerCase());
    // also store the bare (unqualified) name so `scheduling.shift_status` and `shift_status` both hit
    const bare = full.split('.').pop().toLowerCase();
    enumTypeNames.add(bare);
  }
}

// ---------------------------------------------------------------------------------------------
// 3. Heuristics: does a (name,type) pair carry a DOMAIN that demands a DB constraint?
// ---------------------------------------------------------------------------------------------

// Type families that are intrinsically open and DON'T by themselves imply a domain
// (free text, timestamps, booleans, json) — these need a domain signal from the NAME.
const FREEFORM_TYPE = /^(text|varchar|char|character|json|jsonb|bytea|uuid|timestamptz|timestamp|date|time|timetz|boolean|bool|inet|cidr|macaddr|geography|geometry)\b/i;

// A column NAME suggesting an enumerated / coded / categorical domain (needs ENUM type or CHECK IN).
const NAME_ENUMISH = /(^|_)(status|state|kind|type|category|severity|level|mode|method|channel|tier|scope|provider|outcome|frequency|freq|priority|direction|disposition|reason_code|role)$/i;

// A column NAME suggesting a foreign-key relationship (needs REFERENCES / FK). `*_id` or bare `id`
// EXCEPT the table's own surrogate PK (which is `id UUID PRIMARY KEY` — handled by PK detection).
const NAME_FKISH = /(^|_)(id)$/i;

// A column NAME suggesting a constrained numeric range (cents >= 0, counts >= 0, percentages, etc.).
const NAME_RANGEISH = /(^|_)(cents|count|qty|quantity|minutes|seconds|hours|days|radius_m|percent|pct|rate|score|weight|attempt|attempts|retries|version|seq|sequence|order)$/i;

// A column NAME suggesting a format/regex domain (email, phone, slug, code, url) — wants a CHECK
// or a UNIQUE+format guard. Conservative: surface for review if no constraint, but lower severity.
const NAME_FORMATISH = /(^|_)(email|phone|slug|url|uri|domain|zip|postal_code|code)$/i;

// Built-in Postgres types we recognize by name (the freeform set + the plain numerics). A type
// that is NEITHER one of these NOR an enum defined in this migration is very likely a USER-DEFINED
// type (enum / DOMAIN / composite) declared in an EARLIER migration — in which case the type itself
// IS the DB-level constraint, just defined out of this file's view. The gate can't PROVE that from
// one file, so it stays conservative (still flags) but tags the finding soft + cross-migration so a
// reviewer reads it as "verify the type exists" rather than "unconstrained free column".
const PLAIN_NUMERIC_TYPE = /^(bigint|integer|int|int4|int8|smallint|numeric|decimal|real|double|float|money|serial|bigserial)\b/i;
function looksUserDefinedType(bareType, lowerType) {
  if (!bareType) return false;
  if (FREEFORM_TYPE.test(bareType)) return false;
  if (PLAIN_NUMERIC_TYPE.test(bareType)) return false;
  // strip a trailing array marker / size for the recognition check
  const core = bareType.replace(/\s*\[.*$/, '').replace(/\s*\(.*$/, '').trim();
  if (FREEFORM_TYPE.test(core) || PLAIN_NUMERIC_TYPE.test(core)) return false;
  // a schema-qualified name (scheduling.shift_status) or a bare identifier that isn't a builtin
  return /^[A-Za-z_]\w*$/.test(core) || lowerType.includes('.');
}

function classifyDomain(name, type) {
  const t = (type || '').trim();
  const lowerType = t.toLowerCase();
  const bareType = lowerType.split('.').pop();
  const udt = looksUserDefinedType(bareType, lowerType);

  // (a) Column typed AS an enum defined in this migration -> domain=enum (already satisfied by TYPE).
  if (enumTypeNames.has(lowerType) || enumTypeNames.has(bareType)) {
    return { domain: 'enum-type', needed: 'CREATE TYPE ... AS ENUM (the type IS the constraint)', satisfiedByType: true };
  }

  // (b) Self surrogate PK `id` — not a foreign relationship; PRIMARY KEY covers it. Not flagged here
  // (PK presence checked separately so a missing PK doesn't masquerade as an FK gap).
  if (/^id$/i.test(name)) {
    return { domain: 'primary-key', needed: 'PRIMARY KEY', isSelfId: true };
  }

  // (c) FK-shaped name -> needs REFERENCES / FOREIGN KEY.
  if (NAME_FKISH.test(name)) {
    return { domain: 'foreign-key', needed: 'REFERENCES / FOREIGN KEY' };
  }

  // (d) Enum-ish name -> needs ENUM type or CHECK (... IN ...).
  if (NAME_ENUMISH.test(name)) {
    // If the declared type is a user-defined type NOT created in this migration, it is almost
    // certainly an enum/DOMAIN from a prior migration (the type IS the constraint). Stay
    // conservative — still flag — but soft-tag it as a cross-migration type reference to verify,
    // not a bare unconstrained column. (Real case: a new table typed `scheduling.shift_status`,
    // the enum defined back in 053b — flagging it as a hard gap would be a false positive.)
    if (udt) {
      return { domain: 'enumerated', needed: "ENUM type OR CHECK (col IN (...))", soft: true, crossMigrationType: true };
    }
    return { domain: 'enumerated', needed: "ENUM type OR CHECK (col IN (...))" };
  }

  // (e) Range-ish name on a numeric-ish/any type -> needs CHECK range (or be a documented FK like rate_id).
  if (NAME_RANGEISH.test(name)) {
    return { domain: 'numeric-range', needed: 'CHECK (col >= 0 / range)', soft: true };
  }

  // (f) Format-ish name -> wants a CHECK/format or UNIQUE. Soft: surface for review.
  if (NAME_FORMATISH.test(name)) {
    return { domain: 'format', needed: 'CHECK (format) or UNIQUE', soft: true };
  }

  // No domain signal from name; and the TYPE is freeform -> NOT a domain column.
  if (FREEFORM_TYPE.test(bareType)) return null;

  // Otherwise: an unusual / non-freeform type with no name signal. Conservative -> surface softly so
  // a genuinely-constrained-needing column (e.g. a custom composite) isn't silently waved through.
  // BUT exclude obvious plain numerics with no range name (bigint id-less counters are common &
  // legitimately unconstrained); those are too noisy to flag.
  if (PLAIN_NUMERIC_TYPE.test(bareType)) {
    return null;
  }
  // A user-defined type from a prior migration (enum/DOMAIN/composite) is the most likely shape here
  // — tag it cross-migration so the reviewer reads it as "verify the type carries the domain".
  return { domain: 'unknown-type', needed: 'review: non-freeform type, no recognized domain signal', soft: true, crossMigrationType: udt };
}

// ---------------------------------------------------------------------------------------------
// 4. Extract column definitions + their inline constraints, and the table-level constraints,
//    from CREATE TABLE (...) blocks and ALTER TABLE ... ADD COLUMN statements.
// ---------------------------------------------------------------------------------------------

// Split the column list of a CREATE TABLE on top-level commas (commas inside parentheses, e.g.
// NUMERIC(10,2) or CHECK (x IN (...)), do NOT separate definitions).
function splitTopLevelCommas(body) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') { depth++; cur += ch; }
    else if (ch === ')') { depth = Math.max(0, depth - 1); cur += ch; }
    else if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// Find the matching close-paren for the '(' at index `openIdx`. Returns the inner body string, or
// null if unbalanced (degrade gracefully — a half-written migration won't crash us).
function matchParen(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return { inner: s.slice(openIdx + 1, i), end: i }; }
  }
  return null;
}

// Reserved leading tokens that begin a TABLE-LEVEL constraint, not a column definition.
const TABLE_CONSTRAINT_LEAD = /^(constraint|primary\s+key|foreign\s+key|unique|check|exclude|like|partition)\b/i;

// Inline column-constraint detectors (run against a single column definition string).
function inlineConstraints(def) {
  const d = def;
  return {
    references: /\bREFERENCES\b/i.test(d) || /\bFOREIGN\s+KEY\b/i.test(d),
    check: /\bCHECK\s*\(/i.test(d),
    unique: /\bUNIQUE\b/i.test(d),
    primaryKey: /\bPRIMARY\s+KEY\b/i.test(d),
    generated: /\bGENERATED\b/i.test(d),
    notNull: /\bNOT\s+NULL\b/i.test(d),
  };
}

// Parse one column definition: "name TYPE ... <constraints>". Returns {name, type, constraints} or
// null if the fragment is actually a table-level constraint or unparseable.
function parseColumnDef(defRaw) {
  const def = defRaw.trim();
  if (!def) return null;
  if (TABLE_CONSTRAINT_LEAD.test(def)) return null;

  // name: first token. May be quoted "name" — strip quotes.
  const m = def.match(/^("?)([A-Za-z_]\w*)\1\s+(.*)$/s);
  if (!m) return null;
  const name = m[2];
  const rest = m[3].trim();

  // type: take leading type token incl. optional schema-qualifier + optional (n[,m]) + [] array.
  const tm = rest.match(/^([A-Za-z_][\w.]*(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\s*\[\s*\d*\s*\])*)/);
  const type = tm ? tm[1].replace(/\s+/g, ' ').trim() : '';

  return { name, type, def, constraints: inlineConstraints(def) };
}

// Collect table-level constraints from a CREATE TABLE body and map them to the column names they
// reference, so a constraint declared AWAY from the column still counts (PostgreSQL allows both).
// We capture: which columns appear inside any CHECK(...), FOREIGN KEY (cols) REFERENCES, UNIQUE(cols),
// PRIMARY KEY (cols).
function tableLevelConstraintColumns(defs) {
  const checkCols = new Set();      // columns named anywhere in a table-level CHECK
  const fkCols = new Set();         // columns in FOREIGN KEY (...) REFERENCES
  const uniqueCols = new Set();     // columns in UNIQUE (...)
  const pkCols = new Set();         // columns in PRIMARY KEY (...)
  const sawTableCheck = [];         // raw check exprs (for multi-col CHECKs we can't attribute precisely)

  for (const dRaw of defs) {
    const d = dRaw.trim();
    if (!TABLE_CONSTRAINT_LEAD.test(d.replace(/^constraint\s+\w+\s+/i, ''))) {
      // not a table-level constraint definition
      if (!TABLE_CONSTRAINT_LEAD.test(d)) continue;
    }
    const body = d.replace(/^constraint\s+["']?\w+["']?\s+/i, '');

    let mm;
    if ((mm = body.match(/^FOREIGN\s+KEY\s*\(([^)]*)\)/i))) {
      for (const c of colsFromList(mm[1])) fkCols.add(c);
    }
    if ((mm = body.match(/^UNIQUE\s*\(([^)]*)\)/i))) {
      for (const c of colsFromList(mm[1])) uniqueCols.add(c);
    }
    if ((mm = body.match(/^PRIMARY\s+KEY\s*\(([^)]*)\)/i))) {
      for (const c of colsFromList(mm[1])) pkCols.add(c);
    }
    if (/^CHECK\s*\(/i.test(body)) {
      sawTableCheck.push(body);
      // identify identifiers referenced in the check expression (best-effort).
      for (const id of identifiersIn(body)) checkCols.add(id);
    }
  }
  return { checkCols, fkCols, uniqueCols, pkCols, sawTableCheck };
}

function colsFromList(list) {
  return String(list).split(',').map((c) => c.trim().replace(/^["']|["']$/g, '')).filter(Boolean).map((c) => c.toLowerCase());
}
// Best-effort identifier scrape from a CHECK expr (lowercased), excluding SQL keywords/values.
const SQL_WORD = /\b([A-Za-z_]\w*)\b/g;
const KEYWORDS = new Set(['check', 'in', 'and', 'or', 'not', 'is', 'null', 'true', 'false', 'between', 'like', 'similar', 'to', 'any', 'all', 'coalesce', 'case', 'when', 'then', 'else', 'end']);
function identifiersIn(expr) {
  const set = new Set();
  let m;
  while ((m = SQL_WORD.exec(expr)) !== null) {
    const w = m[1].toLowerCase();
    if (!KEYWORDS.has(w)) set.add(w);
  }
  return set;
}

// ---------------------------------------------------------------------------------------------
// 5. Walk the migration: gather (table, column, type, constraints, satisfied?).
// ---------------------------------------------------------------------------------------------

const findings = [];
let domainColumnCount = 0;

function evaluateColumn(table, parsed, tableConstraints) {
  if (!parsed) return;
  const { name, type, constraints } = parsed;
  const cls = classifyDomain(name, type);
  if (!cls) return; // not a domain column

  // The self-id PK is a domain only insofar as it needs a PRIMARY KEY; check that and move on.
  if (cls.isSelfId) {
    const lower = name.toLowerCase();
    const hasPk = constraints.primaryKey || (tableConstraints && tableConstraints.pkCols.has(lower));
    domainColumnCount++;
    const has = !!hasPk;
    findings.push({
      column: name, table, type, domain: 'primary-key',
      hasConstraint: has, needed: cls.needed,
      evidence: has ? (constraints.primaryKey ? 'inline PRIMARY KEY' : 'table-level PRIMARY KEY') : undefined,
    });
    return;
  }

  // A column whose type IS a migration-defined enum is constrained by the type itself.
  if (cls.satisfiedByType) {
    domainColumnCount++;
    findings.push({ column: name, table, type, domain: 'enum-type', hasConstraint: true, needed: cls.needed, evidence: `typed as ENUM ${type}` });
    return;
  }

  const lower = name.toLowerCase();
  const tc = tableConstraints || { checkCols: new Set(), fkCols: new Set(), uniqueCols: new Set(), pkCols: new Set() };

  let has = false;
  let evidence;
  // (i) Best-fit, domain-specific evidence first (yields the clearest message).
  switch (cls.domain) {
    case 'foreign-key':
      if (constraints.references) { has = true; evidence = 'inline REFERENCES'; }
      else if (tc.fkCols.has(lower)) { has = true; evidence = 'table-level FOREIGN KEY'; }
      // an FK-shaped column may also be legitimately covered by an ENUM-typed lookup; but absent a
      // REFERENCES we conservatively flag.
      break;
    case 'enumerated':
      if (constraints.check) { has = true; evidence = 'inline CHECK'; }
      else if (constraints.references) { has = true; evidence = 'inline REFERENCES (lookup table)'; }
      else if (tc.checkCols.has(lower)) { has = true; evidence = 'table-level CHECK references column'; }
      else if (tc.fkCols.has(lower)) { has = true; evidence = 'table-level FOREIGN KEY (lookup table)'; }
      break;
    case 'numeric-range':
      if (constraints.check) { has = true; evidence = 'inline CHECK'; }
      else if (constraints.generated) { has = true; evidence = 'GENERATED'; }
      else if (tc.checkCols.has(lower)) { has = true; evidence = 'table-level CHECK references column'; }
      break;
    case 'format':
      if (constraints.check) { has = true; evidence = 'inline CHECK'; }
      else if (constraints.unique) { has = true; evidence = 'inline UNIQUE'; }
      else if (constraints.references) { has = true; evidence = 'inline REFERENCES (catalog FK pins the value)'; }
      else if (tc.checkCols.has(lower)) { has = true; evidence = 'table-level CHECK references column'; }
      else if (tc.uniqueCols.has(lower)) { has = true; evidence = 'table-level UNIQUE'; }
      break;
    default: // unknown-type
      break;
  }
  // (ii) Universal backstop: ANY genuine DB-level constraint on this column satisfies the
  // principle ("a DB-level constraint exists"), even if it isn't the textbook one for the domain.
  // A column with an inline REFERENCES / CHECK / UNIQUE / GENERATED is demonstrably constrained at
  // the DB level — flagging it would be a false positive that erodes trust in the gate. We keep the
  // conservative posture only for columns with NO such constraint at all.
  if (!has) {
    if (constraints.references) { has = true; evidence = 'inline REFERENCES'; }
    else if (constraints.check) { has = true; evidence = 'inline CHECK'; }
    else if (constraints.unique) { has = true; evidence = 'inline UNIQUE'; }
    else if (constraints.generated) { has = true; evidence = 'GENERATED'; }
    else if (tc.fkCols.has(lower)) { has = true; evidence = 'table-level FOREIGN KEY'; }
    else if (tc.checkCols.has(lower)) { has = true; evidence = 'table-level CHECK references column'; }
    else if (tc.uniqueCols.has(lower)) { has = true; evidence = 'table-level UNIQUE'; }
  }

  domainColumnCount++;
  const finding = { column: name, table, type, domain: cls.domain, hasConstraint: has, needed: cls.needed };
  if (evidence) finding.evidence = evidence;
  if (cls.soft) finding.soft = true; // soft = surfaced for review, lower confidence
  // Cross-migration type reference: the column's declared type is likely an enum/DOMAIN defined in
  // an EARLIER migration (the type itself is the constraint, just out of this file's view). Surface
  // it as a verify-the-type hint, not a bare unconstrained-column gap.
  if (!has && cls.crossMigrationType) finding.note = 'type not defined in this migration — likely an enum/DOMAIN from a prior migration; verify the type carries the domain';
  findings.push(finding);
}

// --- 5a. CREATE TABLE blocks ---------------------------------------------------------------
{
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w.]*)\s*\(/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const table = m[1];
    const openIdx = re.lastIndex - 1; // position of the '('
    const matched = matchParen(sql, openIdx);
    if (!matched) continue; // unbalanced — degrade, skip this block
    const defs = splitTopLevelCommas(matched.inner);
    const tableConstraints = tableLevelConstraintColumns(defs);
    for (const d of defs) {
      const parsed = parseColumnDef(d);
      evaluateColumn(table, parsed, tableConstraints);
    }
    re.lastIndex = matched.end + 1;
  }
}

// --- 5b. ALTER TABLE ... ADD COLUMN [IF NOT EXISTS] <col> <type> <inline constraints> -------
// Each ADD COLUMN clause is its own definition; the inline constraints live on the same clause.
// We split each ALTER statement at the semicolon and scan ADD COLUMN clauses within it.
{
  // Capture "ALTER TABLE <name> ... ;" statements.
  const stmtRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([A-Za-z_][\w.]*)\s+([\s\S]*?);/gi;
  let sm;
  while ((sm = stmtRe.exec(sql)) !== null) {
    const table = sm[1];
    const bodyAll = sm[2];
    // An ALTER can have multiple comma-separated actions; ADD COLUMN is the one we constrain.
    // Split actions on top-level commas so a trailing "ADD CONSTRAINT" action is seen too.
    const actions = splitTopLevelCommas(bodyAll);
    // Also handle table-level ADD CONSTRAINT actions that may constrain a previously/elsewhere
    // added column in the same migration. Collect them for cross-action attribution.
    const addedConstraintCols = { checkCols: new Set(), fkCols: new Set(), uniqueCols: new Set(), pkCols: new Set() };
    const colActions = [];
    for (const aRaw of actions) {
      const a = aRaw.trim();
      const addCol = a.match(/^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(.*)$/is);
      if (addCol) { colActions.push(addCol[1]); continue; }
      const addConstraint = a.match(/^ADD\s+(?:CONSTRAINT\s+["']?\w+["']?\s+)?(FOREIGN\s+KEY|UNIQUE|CHECK|PRIMARY\s+KEY)\b([\s\S]*)$/i);
      if (addConstraint) {
        const kind = addConstraint[1].toUpperCase().replace(/\s+/g, ' ');
        const tail = addConstraint[2] || '';
        let mm;
        if (kind === 'FOREIGN KEY' && (mm = tail.match(/\(([^)]*)\)/))) for (const c of colsFromList(mm[1])) addedConstraintCols.fkCols.add(c);
        else if (kind === 'UNIQUE' && (mm = tail.match(/\(([^)]*)\)/))) for (const c of colsFromList(mm[1])) addedConstraintCols.uniqueCols.add(c);
        else if (kind === 'PRIMARY KEY' && (mm = tail.match(/\(([^)]*)\)/))) for (const c of colsFromList(mm[1])) addedConstraintCols.pkCols.add(c);
        else if (kind === 'CHECK') for (const id of identifiersIn(tail)) addedConstraintCols.checkCols.add(id);
      }
    }
    for (const colDef of colActions) {
      const parsed = parseColumnDef(colDef);
      evaluateColumn(table, parsed, addedConstraintCols);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 6. Verdict. A finding fails the gate when a domain column lacks a paired constraint.
//    Conservative posture: BOTH hard (FK/enum) AND soft (range/format/unknown) gaps fail-toward-
//    surface — i.e. they count as gate failures so a human looks. (Principle 1: serde is not the
//    column.) Soft findings are tagged so the reviewer can see they're heuristic.
// ---------------------------------------------------------------------------------------------

const gaps = findings.filter((f) => f.hasConstraint === false);
const pass = gaps.length === 0;

out({
  ok: pass,
  pass,
  file: targetFile,
  resolvedBy,
  domainColumns: domainColumnCount,
  constrained: findings.filter((f) => f.hasConstraint === true).length,
  gaps: gaps.length,
  findings,
  ...(pass ? {} : { remedy: 'Add a DB-level constraint (CREATE TYPE ... AS ENUM | CHECK | FOREIGN KEY/REFERENCES | UNIQUE | GENERATED) for each column with hasConstraint:false. Heuristic gate — if a flagged column is genuinely domain-free, that is a confer item, not a silent override.' }),
});
process.exit(pass ? 0 : 1);
