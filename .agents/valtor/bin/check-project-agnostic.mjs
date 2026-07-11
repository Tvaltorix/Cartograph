#!/usr/bin/env node
// check-project-agnostic.mjs — the ENGINE-AGNOSTIC guardrail (Layer-A safety, gate-style).
//
// `node check-project-agnostic.mjs`
//
// Valtor's promise is portability: the *mechanism* lives in the universal files and the *instance*
// lives in ONE file (valtor.config.json) + the runtime ledger. This script enforces that promise.
// It scans the universal engine files for host-repo INSTANCE DATA that should never be baked into
// the mechanism, and BLOCKS (exit non-zero) when it finds a hard leak. Run it after any edit to the
// engine — it is both the standing guardrail and the leak-hunt tool. Repo-specific knowledge lives
// in config (this script knows NOTHING about any particular repo): the token list and the scan set
// are read from config; the structural patterns below are universal "instance data" shapes.
//
// Three leak layers (all read their specifics from config; the script itself is generic):
//   A. repoTokens          — config.agnosticGuardrail.repoTokens: the host's proper nouns / brands
//                            (project name, company, the product it replaces, principals). Empty by
//                            default — a fresh repo populates it. The engine's OWN name is never a
//                            leak, so it is never in this list.
//   B. structural          — universal shapes that are always instance data regardless of repo:
//                            cloud account ids, ARNs, cloud region codes, email addresses, absolute
//                            home paths. Always on; need no config.
//   C. config-value leak   — the literal VALUE of a host-specific config path (masterContext + the
//                            propagation paths) must not appear in a universal file: the file should
//                            reference the config KEY, not hardcode the value. Auto-derived from the
//                            live config, plus config.agnosticGuardrail.extraForbiddenLiterals.
//
// CONTRACT (README): single JSON object to stdout; exit 0 = clean (no hard leak), exit 1 = leak
// found (gate-block). It must never throw a stack trace and must run cleanly on a fresh repo (no
// tokens configured → only structural + config-value layers run).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { matchesAny, ok, fail, existsSync, CONFIG_PATH } from './lib.mjs';

// --- safe IO (mirrors the detector house style) ------------------------------------
function readTextSafe(path) { try { return readFileSync(path, 'utf8'); } catch { return null; } }

function walkFiles(root, { cap = 200000 } = {}) {
  const out = [];
  if (!root || !existsSync(root)) return out;
  // An exact-file glob (no wildcard) resolves its root to the file itself; readdirSync would
  // throw and silently drop it from the scan set — return the file directly instead.
  try { if (statSync(root).isFile()) return [String(root).replace(/\\/g, '/')]; } catch { return out; }
  const stack = [root];
  const seenDirs = new Set();
  let visited = 0;
  while (stack.length > 0) {
    if (visited >= cap) break;
    const dir = stack.pop();
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      visited += 1;
      if (visited >= cap) break;
      const full = join(dir, ent.name);
      let isDir = false; let isFile = false;
      try {
        if (ent.isDirectory()) isDir = true;
        else if (ent.isFile()) isFile = true;
        else if (ent.isSymbolicLink()) { const st = statSync(full); isDir = st.isDirectory(); isFile = st.isFile(); }
      } catch { continue; }
      if (isDir) stack.push(full);
      else if (isFile) out.push(full.replace(/\\/g, '/'));
    }
  }
  return out;
}

function globWalkRoot(glob) {
  const g = String(glob || '').replace(/\\/g, '/');
  const stable = [];
  for (const s of g.split('/')) { if (/[*?[]/.test(s)) break; stable.push(s); }
  const root = stable.join('/');
  return root.length > 0 ? root : '.';
}
// lib.globToRegex requires `**/` to span ≥1 dir; OR in the elided forms so a file sitting directly
// in the `**` position still matches (same widening the detectors use).
function globVariants(glob) {
  const g = String(glob || '');
  const v = new Set([g]);
  if (g.includes('**/')) { v.add(g.replace(/\*\*\//g, '')); v.add(g.replace(/\*\*\/([^/]*)$/, '$1')); }
  return [...v];
}

function loadConfigSafe() {
  if (!existsSync(CONFIG_PATH)) return { config: null, warn: `config not found at ${CONFIG_PATH} — fresh repo` };
  let raw;
  try { raw = readFileSync(CONFIG_PATH, 'utf8'); } catch (e) { return { config: null, warn: `config unreadable: ${e && e.message}` }; }
  try { return { config: JSON.parse(raw), warn: null }; } catch (e) { return { config: null, warn: `config parse error: ${e && e.message}` }; }
}

// --- the universal file set + exclusions -------------------------------------------
// Defaults describe the portable file set (SCHEMA §8). Excluded: the config seam, the runtime
// ledger, the generated projections (host-specific by design), and this script itself (it carries
// the structural-pattern source strings, which would otherwise self-match).
const DEFAULT_SCAN = [
  '.claude/skills/valtor/**',
  '.claude/agents/valtor-*.md',
  '.agents/valtor/SCHEMA.md',
  '.agents/valtor/MODES.md',
  '.agents/valtor/README.md',
  '.agents/valtor/ROADMAP.md',
  '.agents/valtor/registry.json',
  '.agents/valtor/bin/**',
];
const DEFAULT_EXCLUDE = [
  '**/valtor.config.json',
  '.agents/valtor/index/**',
  '.agents/valtor/bin/check-project-agnostic.mjs',
  '.agents/valtor/BOARD.md',
  '.agents/valtor/READINESS.md',
  '.agents/valtor/BLOCKERS.md',
  '.agents/valtor/ROADMAP.md',          // when ROADMAP is treated as a generated projection; harmless if static
  '.agents/valtor/system-map.md',
  '.agents/valtor/QA-BRIEF.md',
  '**/*.jsonl',
];

// --- structural patterns (Layer B) — universal instance-data shapes ----------------
// Built from parts so this file contains no literal sample region/account that would self-match
// elsewhere. The region regex is assembled from fragments for the same reason.
const ACCOUNT_RE = /\b\d{12}\b/g;
const ARN_RE = /\barn:aws[a-z-]*:/gi;
const REGION_RE = new RegExp(
  '\\b(?:us|eu|ap|ca|sa|af|me|il)-(?:gov-)?(?:' +
  ['east', 'west', 'north', 'south', 'central', 'northeast', 'northwest', 'southeast', 'southwest'].join('|') +
  ')-\\d\\b', 'gi');
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const HOMEPATH_RE = /(?:\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+)/g;

const STRUCTURAL = [
  { rule: 'cloud-account-id', re: ACCOUNT_RE },
  { rule: 'arn', re: ARN_RE },
  { rule: 'cloud-region', re: REGION_RE },
  { rule: 'email-address', re: EMAIL_RE, allow: (m) => /@[^@]*example\./i.test(m) },
  { rule: 'absolute-home-path', re: HOMEPATH_RE },
];

// Build the Layer-A token matchers from config.agnosticGuardrail.repoTokens. A token with no
// spaces/special chars matches on word boundaries (so a token like "acme" never trips on "acmeform");
// a multi-word token matches case-insensitively as a literal.
function tokenMatchers(tokens) {
  return (tokens || []).filter((t) => typeof t === 'string' && t.trim()).map((t) => {
    const trimmed = t.trim();
    const simple = /^[A-Za-z0-9]+$/.test(trimmed);
    const esc = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { token: trimmed, re: new RegExp(simple ? `\\b${esc}\\b` : esc, 'gi') };
  });
}

// Layer C: derive the host-specific literal values that must not be hardcoded into the mechanism.
// CONVENTIONAL is platform-universal knowledge (NOT repo knowledge): "CLAUDE.md" is the Claude Code
// convention for a master-context doc — every Claude Code repo may have one — so it is the one
// masterContext value that is NOT instance data and is allowed to appear by name. (A repo that sets
// masterContext to a non-conventional path, e.g. "docs/context.md", WILL be flagged if hardcoded.)
const CONVENTIONAL_LITERALS = new Set(['claude.md']);
function forbiddenLiterals(config, extra) {
  const out = new Set();
  const add = (v) => {
    if (typeof v === 'string' && v.length >= 4 && !CONVENTIONAL_LITERALS.has(v.toLowerCase())) out.add(v);
  };
  if (config) {
    add(config.masterContext);
    const p = config.propagation || {};
    // The propagation path values (the failure catalog, ADR dir, timeline, state dir, claudeMd).
    // systemMap lives under the engine home and IS referenced by path in the mechanism, so skip it.
    for (const k of ['claudeMd', 'adrDir', 'timeline', 'failures', 'stateDir']) add(p[k]);
  }
  for (const v of (extra || [])) add(v);
  return [...out];
}

function lineColOf(text, index) {
  let line = 1; let last = 0;
  for (let i = 0; i < index; i += 1) if (text[i] === '\n') { line += 1; last = i + 1; }
  return { line, col: index - last + 1 };
}

function scanText(file, text, { matchers, literals }) {
  const hits = [];
  const push = (rule, match, idx) => {
    const { line } = lineColOf(text, idx);
    hits.push({ file, line, rule, match: String(match).slice(0, 80) });
  };
  // Layer A — repo proper-noun tokens.
  for (const m of matchers) {
    m.re.lastIndex = 0; let x;
    while ((x = m.re.exec(text)) !== null) { push(`repo-token:${m.token}`, x[0], x.index); if (m.re.lastIndex === x.index) m.re.lastIndex += 1; }
  }
  // Layer B — structural shapes.
  for (const s of STRUCTURAL) {
    s.re.lastIndex = 0; let x;
    while ((x = s.re.exec(text)) !== null) {
      const val = x[0];
      if (!(s.allow && s.allow(val))) push(s.rule, val, x.index);
      if (s.re.lastIndex === x.index) s.re.lastIndex += 1;
    }
  }
  // Layer C — host config-value literals.
  for (const lit of literals) {
    let from = 0; let idx;
    while ((idx = text.indexOf(lit, from)) !== -1) { push(`config-value-literal:${lit}`, lit, idx); from = idx + lit.length; }
  }
  return hits;
}

function main() {
  const { config, warn } = loadConfigSafe();
  const gcfg = (config && config.agnosticGuardrail) || {};
  const scanGlobs = Array.isArray(gcfg.scanGlobs) && gcfg.scanGlobs.length ? gcfg.scanGlobs : DEFAULT_SCAN;
  const excludeGlobs = Array.isArray(gcfg.excludeGlobs) && gcfg.excludeGlobs.length ? gcfg.excludeGlobs : DEFAULT_EXCLUDE;
  const matchers = tokenMatchers(gcfg.repoTokens);
  const literals = forbiddenLiterals(config, gcfg.extraForbiddenLiterals);

  const degraded = [];
  if (warn) degraded.push(warn);

  // Resolve the scan set: walk each glob's static root, keep files matching a scan glob and not an
  // exclude glob. Dedupe.
  const seen = new Set();
  const files = [];
  for (const g of scanGlobs) {
    const variants = globVariants(g);
    for (const f of walkFiles(globWalkRoot(g))) {
      if (seen.has(f)) continue;
      if (!matchesAny(f, variants)) continue;
      if (matchesAny(f, excludeGlobs)) continue;
      seen.add(f); files.push(f);
    }
  }

  const findings = [];
  for (const file of files) {
    const text = readTextSafe(file);
    if (text === null) { degraded.push(`unreadable: ${file}`); continue; }
    findings.push(...scanText(file, text, { matchers, literals }));
  }

  const result = {
    clean: findings.length === 0,
    scanned: files.length,
    leaks: findings.length,
    byRule: findings.reduce((a, f) => { a[f.rule] = (a[f.rule] || 0) + 1; return a; }, {}),
    findings: findings.slice(0, 200),
    config: { repoTokens: (gcfg.repoTokens || []).length, literals: literals.length, scanGlobs: scanGlobs.length },
  };
  if (degraded.length) result.degraded = degraded;
  if (findings.length > 0) {
    return fail('engine-agnostic guardrail: host-repo instance data found in the universal engine files — move it to valtor.config.json or reference the config key', result);
  }
  return ok(result);
}

try { main(); }
catch (e) { fail(`unexpected error: ${e && e.message ? e.message : String(e)}`); }
