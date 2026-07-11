// Valtor shared library. Zero external deps (node builtins only) so it runs in any repo.
// Every bin/ script imports from here so ledger format, config access, paths, and glob matching
// stay identical across scripts. The LOGIC here is universal; everything repo-specific is read
// from .agents/valtor/valtor.config.json (the only per-repo seam).
import { readFileSync, appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

export const HOME = process.env.VALTOR_HOME || '.agents/valtor';
export const INDEX = join(HOME, 'index');
export const CONFIG_PATH = join(HOME, 'valtor.config.json');

// The ledger tables (SCHEMA §3.1). Committed *.jsonl except run_journal (git-ignored).
export const TABLES = [
  'items', 'gate_results', 'status_transitions', 'decisions', 'failures',
  'plans', 'edges', 'contracts', 'concerns', 'run_journal', 'budget',
];

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) fail(`config not found at ${CONFIG_PATH} — run init.mjs or create the seam file`);
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { return fail(`config parse error: ${e.message}`); }
}

export function nowIso() { return new Date().toISOString(); }
export function uuid() { return randomUUID(); }
export function sha256(s) { return createHash('sha256').update(s).digest('hex'); }

export function ensureIndex() { if (!existsSync(INDEX)) mkdirSync(INDEX, { recursive: true }); }
export function tablePath(table) { return join(INDEX, `${table}.jsonl`); }

// Append one JSON row (auto-stamped with ts) to a table's jsonl. jsonl IS the source of truth;
// any SQLite index is a derived, rebuildable accelerator (absent in the reference impl).
export function appendRow(table, row) {
  if (!TABLES.includes(table)) return fail(`unknown table: ${table} (known: ${TABLES.join(', ')})`);
  ensureIndex();
  const stamped = { ts: nowIso(), ...row };
  appendFileSync(tablePath(table), JSON.stringify(stamped) + '\n');
  return stamped;
}

export function readRows(table) {
  const p = tablePath(table);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { return fail(`corrupt row ${i + 1} in ${table}: ${e.message}`); }
  });
}

// Git wrapper. Throws on non-zero exit — callers decide whether that's fatal.
export function git(args, opts = {}) {
  return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}
export function tryGit(args) { try { return { ok: true, out: git(args) }; } catch (e) { return { ok: false, err: String(e.stderr || e.message) }; } }

// Minimal glob -> RegExp. `**/` = zero-or-more directories (so services/**/*.rs matches BOTH
// services/main.rs and services/a/b/main.rs); `**` = anything across separators; `*` = within a
// segment. Paths normalized to forward slashes first. Uses string sentinels (no control chars).
export function globToRegex(glob) {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '<<GS_DIR>>')
    .replace(/\*\*/g, '<<GS>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<GS_DIR>>/g, '(?:.*/)?')
    .replace(/<<GS>>/g, '.*');
  return new RegExp('^' + re + '$');
}
export function matchesAny(path, patterns) {
  const p = String(path).replace(/\\/g, '/');
  return (patterns || []).some(g => globToRegex(g).test(p));
}

// Parse a duration like "30m", "90s", "2h" -> milliseconds.
export function parseDuration(s) {
  const m = String(s).match(/^(\d+)\s*(s|m|h)$/);
  if (!m) return 0;
  const n = Number(m[1]); return n * { s: 1e3, m: 6e4, h: 36e5 }[m[2]];
}

export const args = () => process.argv.slice(2);
export function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }
export function ok(obj = {}) { out({ ok: true, ...obj }); process.exit(0); }
export function fail(msg, extra = {}) { out({ ok: false, error: msg, ...extra }); process.exit(1); }
export { rmSync, existsSync };
