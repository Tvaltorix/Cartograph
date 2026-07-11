#!/usr/bin/env node
// gate-reconcile-sweep.mjs — Layer-A gate G1 Reconcile Sweep (SCHEMA §1 RECONCILE, §4, registry G1-reconcile-sweep).
//
// The MECHANICAL half of the inbound doc sweep. When a new plan lands, some of the host's anchored
// docs (the master-context doc, ADRs, state/reference docs, architecture notes — all enumerated in
// config.reconcileSweep.targets) may carry wording the plan changes.
// This script grep-finds the CANDIDATE stale lines: for each <term> the plan changes, every line in
// every swept file that mentions it. The JUDGMENT — is this a real CONTRADICTION (HALT/confer) or
// merely COSMETIC drift (auto-fix) — stays with the orchestrator. We just hand it the candidates.
//
// Usage:
//   node gate-reconcile-sweep.mjs <plan-path> [term1,term2,...]
//     <plan-path>  the plan being ingested (recorded in the output for provenance; not required to exist)
//     [terms]      OPTIONAL comma-separated wording the plan changes (case-insensitive substring match).
//                  If omitted/empty, we scan + count files but report zero matches (nothing to look for).
//
// Output: { ok:true, plan, terms:[...], scannedFiles:N, skippedTargets:[...], matches:[ {file,line,term,snippet} ] }
//
// CONTRACT: this gate NEVER blocks — it only informs. Exit 0 ALWAYS on a completed scan (empty config,
// no targets, no terms, no matches, missing files, git absent → clean partial/empty result + exit 0).
// We deliberately do NOT use lib's fail() for any of those degradation paths (fail() exits 1). The one
// hard-exit path is lib's loadConfig() itself aborting on a genuinely unparseable config file.

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, matchesAny, args, out } from './lib.mjs';

// Bound the scan so a pathological repo (huge binaries, runaway file counts) can never hang or OOM the
// gate. These are safety rails, not repo-specific tunables — a stale-wording candidate lives in a small
// markdown doc, never in a multi-megabyte blob.
const MAX_FILE_BYTES = 5 * 1024 * 1024; // skip files larger than 5 MB (not prose docs)
const MAX_FILES = 5000;                 // stop discovering after this many candidate files
const MAX_MATCHES = 5000;               // cap reported matches so output stays bounded
const SNIPPET_MAX = 240;                // trim each reported line so output stays readable
const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.next', 'coverage']);

// Always print exactly one JSON object, then exit 0. Centralized so every return path is uniform.
function report(obj) {
  out({ ok: true, ...obj });
  process.exit(0);
}

// Split a target glob into a fixed base directory + the remaining pattern. We walk the base dir and
// match candidates against the FULL glob via lib's matchesAny (same glob semantics every script uses),
// so behavior here is identical to scope-check / conflict-zone matching. A glob with no wildcard in its
// leading segments (e.g. "CLAUDE.md", "docs/x.md") yields a tight base; a "**" prefix walks from ".".
function baseDirOf(glob) {
  const parts = String(glob).replace(/\\/g, '/').split('/');
  const base = [];
  for (const p of parts) {
    if (p.includes('*') || p.includes('?') || p.includes('[')) break;
    base.push(p);
  }
  // Drop a trailing concrete filename segment from the base (we want a DIRECTORY to walk). If the whole
  // glob is wildcard-free (a literal file path), base === the path and we special-case it below.
  if (base.length === parts.length) return { dir: '.', literal: parts.join('/') };
  return { dir: base.length ? base.join('/') : '.', literal: null };
}

// Recursively collect files under dir, skipping noise dirs, oversized files, and anything that throws on
// stat/readdir (a permission error or a vanished file mid-walk must degrade, never crash). Returns paths
// with forward slashes so glob matching is platform-uniform.
function walk(dir, acc, seenDirs) {
  if (acc.length >= MAX_FILES) return;
  let real;
  try { real = statSync(dir); } catch { return; }            // gone / unreadable → skip
  if (!real.isDirectory()) {
    // A direct file path was handed in (literal target). Record it if it fits.
    if (real.size <= MAX_FILE_BYTES) acc.push(dir.replace(/\\/g, '/'));
    return;
  }
  // Guard against symlink loops / re-walking the same real dir.
  const key = dir.replace(/\\/g, '/');
  if (seenDirs.has(key)) return;
  seenDirs.add(key);

  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (acc.length >= MAX_FILES) return;
    const name = ent.name;
    const full = join(dir, name);
    let isDir = ent.isDirectory();
    let isFile = ent.isFile();
    // Resolve symlinks defensively (Dirent may report them as neither file nor dir).
    if (!isDir && !isFile) {
      try {
        const s = statSync(full);
        isDir = s.isDirectory();
        isFile = s.isFile();
      } catch { continue; }
    }
    if (isDir) {
      if (SKIP_DIRS.has(name)) continue;
      walk(full, acc, seenDirs);
    } else if (isFile) {
      let size = 0;
      try { size = statSync(full).size; } catch { continue; }
      if (size > MAX_FILE_BYTES) continue;
      acc.push(full.replace(/\\/g, '/'));
    }
  }
}

// Expand a target glob into the concrete file set under the repo, each kept only if it matches the FULL
// glob. A literal (wildcard-free) target is matched verbatim. Missing base dir / missing file → empty.
function expandTarget(glob, fileCache, seenDirs) {
  const g = String(glob).replace(/\\/g, '/');
  const { dir, literal } = baseDirOf(g);

  // Literal file path: include it iff it exists and fits. No globbing needed.
  if (literal !== null) {
    if (!existsSync(literal)) return [];
    let s;
    try { s = statSync(literal); } catch { return []; }
    if (!s.isFile() || s.size > MAX_FILE_BYTES) return [];
    return [literal.replace(/\\/g, '/')];
  }

  // Wildcard glob: walk the base dir once (cached across targets that share a base), then keep files that
  // match the full glob. matchesAny is wrapped so a malformed glob can never throw a stack trace.
  if (!fileCache.has(dir)) {
    const acc = [];
    if (existsSync(dir)) walk(dir, acc, seenDirs);
    fileCache.set(dir, acc);
  }
  const candidates = fileCache.get(dir) || [];
  const matched = [];
  for (const f of candidates) {
    let hit = false;
    try { hit = matchesAny(f, [g]); } catch { hit = false; }
    if (hit) matched.push(f);
  }
  return matched;
}

function main() {
  const [planPath, termCsv] = args();

  // Defensive: a missing plan-path is not fatal here (this gate informs; it doesn't validate the plan).
  // Record whatever was passed so the orchestrator has provenance; default to '(unspecified)'.
  const plan = planPath && typeof planPath === 'string' ? planPath : '(unspecified)';

  // Parse terms: comma-separated, trimmed, de-duped, lower-cased for case-insensitive matching. An
  // omitted/empty list is valid — we still report the scanned-file count so the orchestrator sees the
  // sweep ran; there is simply nothing to grep for.
  const terms = [...new Set(
    String(termCsv || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
  )];
  const lowerTerms = terms.map((t) => ({ raw: t, low: t.toLowerCase() }));

  // loadConfig() exits non-zero only on a genuinely unparseable config — acceptable hard failure.
  const config = loadConfig();
  const rawTargets = (config && config.reconcileSweep && config.reconcileSweep.targets) || [];
  // Keep only non-empty string globs; a malformed (non-string) target can't expand to anything.
  const targets = Array.isArray(rawTargets) ? rawTargets.filter((t) => typeof t === 'string' && t.length > 0) : [];

  // No configured targets → nothing to sweep. Clean empty result, exit 0 (fresh-repo / missing-key path).
  if (targets.length === 0) {
    return report({ plan, terms, scannedFiles: 0, skippedTargets: [], matches: [] });
  }

  // Expand every target to a concrete, de-duped file set. fileCache + seenDirs shared across targets so a
  // shared base dir is walked once.
  const fileCache = new Map();
  const seenDirs = new Set();
  const fileSet = new Set();
  const skippedTargets = [];
  for (const t of targets) {
    let files = [];
    try { files = expandTarget(t, fileCache, seenDirs); } catch { files = []; }
    if (files.length === 0) skippedTargets.push(t); // glob matched nothing (absent dir/file) — informational
    for (const f of files) fileSet.add(f);
  }
  const files = [...fileSet].sort();

  // No terms to look for → report the file count but no matches. The sweep still "ran".
  if (lowerTerms.length === 0) {
    return report({ plan, terms, scannedFiles: files.length, skippedTargets, matches: [] });
  }

  // Grep each file line-by-line for each term (case-insensitive substring). Record {file,line,term,snippet}.
  const matches = [];
  let truncated = false;
  for (const file of files) {
    if (matches.length >= MAX_MATCHES) { truncated = true; break; }
    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; } // unreadable mid-walk → skip
    // Normalize line endings so a CRLF file reports the same line numbers as an LF file.
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (matches.length >= MAX_MATCHES) { truncated = true; break; }
      const line = lines[i];
      const low = line.toLowerCase();
      for (const { raw, low: needle } of lowerTerms) {
        if (low.includes(needle)) {
          let snippet = line.trim();
          if (snippet.length > SNIPPET_MAX) snippet = snippet.slice(0, SNIPPET_MAX) + '…';
          matches.push({ file, line: i + 1, term: raw, snippet });
          // One match row per (line, term). A line can match multiple distinct terms → multiple rows.
        }
      }
    }
  }

  const result = { plan, terms, scannedFiles: files.length, skippedTargets, matches };
  if (truncated) result.truncated = { atMatches: MAX_MATCHES };
  return report(result);
}

main();
