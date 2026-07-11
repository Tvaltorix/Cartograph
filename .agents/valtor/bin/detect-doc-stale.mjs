#!/usr/bin/env node
// detect-doc-stale.mjs — Layer-A detector `doc-stale-content-hash` (registry detectors[],
// class "stale"; SCHEMA §5 doc-stale + §5 "Detectors are READ-ONLY ... report, never block").
//
// `node detect-doc-stale.mjs`
//   Walk the `items` ledger. For every item whose kind is in {doc_anchor, knowledge} that
//   carries ALL of referent_path + content_hash + last_seen_commit, flag it STALE when:
//     (a) the referent file no longer exists on disk, OR
//     (b) the referent file's current sha256 differs from the recorded content_hash, OR
//     (c) a cited `file:line` (in referent_path itself, or in goal/text/success_criteria)
//         points past the current end of its file (the cited line is gone).
//   Prints { findings:[{ id, referent_path, reason }], ... }. Empty/absent ledger -> [].
//
// CONTRACT: detectors are READ-ONLY (no Edit/Write to the tree) and REPORT — they never
// block. So this script ALWAYS exits 0, even on a corrupt row, a git-absent repo, an empty
// ledger, or a missing config key. Every specific (which kinds, where the ledger lives) is
// read from lib/config; nothing repo-specific is hardcoded.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INDEX, sha256, ok, existsSync,
} from './lib.mjs';

// Tolerant `items` ledger reader. lib.readRows() is unusable here: on a corrupt line it
// calls lib.fail(), which does process.exit(1) INTERNALLY — a try/catch around it can't
// stop the exit, and a corrupt ledger row must never make a READ-ONLY detector block.
// So we read the jsonl ourselves: parse line-by-line, skip + count unparseable rows, and
// degrade an absent file to []. Mirrors readRows' path resolution via the INDEX seam.
function readItemsTolerant() {
  const p = join(INDEX, 'items.jsonl');
  if (!existsSync(p)) return { rows: [], corruptLines: 0, readError: null };
  let raw;
  try { raw = readFileSync(p, 'utf8'); }
  catch (e) { return { rows: [], corruptLines: 0, readError: String((e && e.message) || e) }; }
  const rows = [];
  let corruptLines = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue; // skip blank lines (trailing newline, etc.)
    try { rows.push(JSON.parse(line)); }
    catch { corruptLines += 1; } // skip the bad row, keep scanning the rest
  }
  return { rows, corruptLines, readError: null };
}

// The two ledger kinds this detector judges. Hardcoding these two strings is NOT a
// repo-specific value — they are the universal LoopItem.kind enum from SCHEMA §3, the
// same in every repo. The SPEC names them explicitly: (doc_anchor, knowledge).
const STALE_KINDS = new Set(['doc_anchor', 'knowledge']);

// --- helpers ---------------------------------------------------------------------

// Read a file's text, tolerating absence / permission / binary issues. Returns null on
// any failure so callers can degrade instead of throwing.
function readTextSafe(path) {
  try { return readFileSync(path, 'utf8'); }
  catch { return null; }
}

// sha256 of file content, both as-read and CRLF-normalized. We don't know whether the
// stored content_hash was taken over raw bytes or normalized text, so a match against
// EITHER form clears the hash check — a bare CRLF<->LF flip must not read as drift
// (same defensive stance as plan-drift.mjs). Returns { raw, normalized } or null if the
// file can't be read.
function fileHashes(path) {
  const text = readTextSafe(path);
  if (text === null) return null;
  return {
    raw: sha256(text),
    normalized: sha256(text.replace(/\r\n/g, '\n')),
  };
}

// Count lines in a text blob (CRLF-normalized). An empty file is 0 lines; "a\n" is 1
// addressable line; "a\nb" is 2.
function lineCount(text) {
  const norm = String(text).replace(/\r\n/g, '\n');
  if (norm.length === 0) return 0;
  // Trailing newline shouldn't invent a phantom final line.
  const body = norm.endsWith('\n') ? norm.slice(0, -1) : norm;
  return body.split('\n').length;
}

// Parse a `path:line` citation. Returns { file, line } when the trailing segment is a
// positive integer line number, else null. Windows-friendly: only a colon followed by
// digits to end-of-string counts, so a drive letter ("C:/x") or a bare path never
// false-matches. We operate on forward-slashed paths.
function parseFileLine(s) {
  if (typeof s !== 'string') return null;
  const m = s.replace(/\\/g, '/').match(/^(.+):(\d+)$/);
  if (!m) return null;
  const line = Number(m[2]);
  if (!Number.isInteger(line) || line < 1) return null;
  return { file: m[1], line };
}

// Gather every `file:line` citation we can see for an item: the referent_path (if it is
// itself a citation) plus any citation embedded in goal / text / success_criteria. Used
// for reason (c). De-duplicated by "file:line" key. Never throws.
function collectCitations(item) {
  const out = [];
  const seen = new Set();
  const push = (cite) => {
    if (!cite) return;
    const key = `${cite.file}:${cite.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(cite);
  };

  // referent_path may carry its own line (e.g. "docs/03.md:148").
  push(parseFileLine(item.referent_path));

  // Scan free-text fields for `path:line` tokens. Tokens are whitespace/paren/quote/comma
  // -delimited; we only keep ones whose file segment looks path-like (contains a dot or a
  // slash) so we don't flag prose like "see step 3:5" as a code citation.
  const texts = [];
  if (typeof item.goal === 'string') texts.push(item.goal);
  if (typeof item.text === 'string') texts.push(item.text);
  if (Array.isArray(item.success_criteria)) {
    for (const c of item.success_criteria) if (typeof c === 'string') texts.push(c);
  }
  const tokenRe = /[^\s()'"`,;]+:\d+/g;
  for (const t of texts) {
    const matches = String(t).match(tokenRe) || [];
    for (const tok of matches) {
      const cite = parseFileLine(tok);
      if (cite && (cite.file.includes('/') || cite.file.includes('.'))) push(cite);
    }
  }
  return out;
}

// Decide why (if at all) an in-scope item is stale. Returns a reason string, or null when
// the item is current. Order matters: a missing file short-circuits the rest. Cached
// file-content lookups keep this O(files) not O(citations).
function stalenessReason(item) {
  const ref = item.referent_path;

  // For the file-existence + hash checks we use the *file* part of the referent, which may
  // be a bare path or a `path:line` citation. A `path:line` referent still has a real file.
  const refCite = parseFileLine(ref);
  const refFile = refCite ? refCite.file : ref;

  // (a) referent file gone.
  if (!existsSync(refFile)) {
    return 'referent file missing';
  }

  // (b) content hash drift on the referent file.
  const hashes = fileHashes(refFile);
  if (hashes === null) {
    // File exists per existsSync but can't be read (perms / race / binary decode). Treat
    // as unreadable rather than asserting drift — surface it honestly.
    return 'referent file unreadable';
  }
  const stored = String(item.content_hash);
  if (hashes.raw !== stored && hashes.normalized !== stored) {
    return 'content hash mismatch';
  }

  // (c) a cited file:line is gone (line index past current end of its file). Check the
  // referent's own line first, then any embedded citations.
  const citations = collectCitations(item);
  const textCache = new Map(); // file -> { lines } | { missing:true } | { unreadable:true }
  for (const cite of citations) {
    let info = textCache.get(cite.file);
    if (!info) {
      if (!existsSync(cite.file)) info = { missing: true };
      else {
        const text = readTextSafe(cite.file);
        info = text === null ? { unreadable: true } : { lines: lineCount(text) };
      }
      textCache.set(cite.file, info);
    }
    if (info.missing) return `cited file gone: ${cite.file}`;
    if (info.unreadable) continue; // can't judge; don't false-flag
    if (cite.line > info.lines) return `cited line gone: ${cite.file}:${cite.line}`;
  }

  return null;
}

// --- main ------------------------------------------------------------------------

function main() {
  // Tolerant read: absent ledger -> []; a corrupt row is skipped + counted, NOT a block
  // (detectors report, never fail). See readItemsTolerant() for why lib.readRows() is
  // unsafe here.
  const { rows: items, corruptLines, readError } = readItemsTolerant();

  const findings = [];
  let scanned = 0;       // items whose kind is in scope
  let eligible = 0;      // in-scope items carrying all three required fields
  let skippedKind = 0;   // wrong kind
  let skippedFields = 0; // right kind, missing one of the three required fields

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (!STALE_KINDS.has(item.kind)) { skippedKind += 1; continue; }
    scanned += 1;

    // SPEC: only items that CARRY referent_path + content_hash + last_seen_commit are
    // judged. Missing any one -> not enough provenance to call staleness; skip cleanly.
    const hasReferent = typeof item.referent_path === 'string' && item.referent_path.length > 0;
    const hasHash = typeof item.content_hash === 'string' && item.content_hash.length > 0;
    const hasCommit = typeof item.last_seen_commit === 'string' && item.last_seen_commit.length > 0;
    if (!hasReferent || !hasHash || !hasCommit) { skippedFields += 1; continue; }
    eligible += 1;

    let reason = null;
    try {
      reason = stalenessReason(item);
    } catch {
      // A single malformed item must never abort the whole sweep. Skip it; the rest of
      // the ledger still gets judged.
      continue;
    }
    if (reason) {
      findings.push({ id: item.id, referent_path: item.referent_path, reason });
    }
  }

  const result = {
    findings,
    scannedKinds: [...STALE_KINDS],
    counts: {
      scanned, eligible, skippedKind, skippedFields, findings: findings.length, corruptRows: corruptLines,
    },
  };
  if (readError) result.ledgerReadWarning = readError;
  // Detector contract: report, never block. Always exit 0 (ok()).
  return ok(result);
}

main();
