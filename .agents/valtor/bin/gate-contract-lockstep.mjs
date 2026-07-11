#!/usr/bin/env node
// gate-contract-lockstep.mjs — Layer-A gate G4c (SCHEMA §4, S7 INTEGRATE; registry "G4c-contract-lockstep").
//
// Intent (registry): "Run event/route/migration lockstep extractors against the just-integrated diff;
// block if one side of a pinned contract landed without the other (moved inline from the S9 sweep)."
//
// Contract shapes + the sides each MUST have all of:
//   event     : emitter      (a service emits the detail-type)
//             + fanout       (signalr fanout router maps the detail-type)
//             + portal       (portal subscriber registers the camelCase target handler)
//   route     : handler      (a backend service registers the route path)
//             + ui           (the portal api-client references the route path)
//   migration : column       (the migration adds/declares the column)
//             + constraint   (the migration declares a DB-level constraint for it — §"DB-constraint" principle)
//             + model        (a backend source references the column in a query / serde struct)
//
// MODE OF OPERATION (the "lockstep on the just-integrated diff" rule):
//   1. Determine the CHANGED SET (a diff blob, an explicit file list, or `git diff --name-only HEAD`).
//   2. Run the three extractors RESTRICTED to the changed files → this tells us which contract SHAPES
//      this diff *touched* (a new emitter line, a new route, a new migration column, etc.).
//   3. For each touched shape, check whether ALL sides are present ACROSS THE WHOLE REPO — because a
//      side can legitimately live in an unchanged file (e.g. the portal handler was already there and
//      this diff only added the emitter). A missing side is a lockstep violation → block.
//
// This is why we extract two different ways: changed-set to FIND touched shapes, full-repo to PROVE
// every side landed. A diff that adds an emitter without the fanout route or portal handler is exactly
// BUG-2 / BUG-3 from the 2026-06-08 SignalR ship — this gate is the codified form of that catch.
//
// Usage:
//   node gate-contract-lockstep.mjs                         # changed set = git diff --name-only HEAD
//   node gate-contract-lockstep.mjs path/a.rs path/b.tsx    # explicit changed file list (space args)
//   node gate-contract-lockstep.mjs a.rs,b.tsx              # explicit changed file list (csv)
//   node gate-contract-lockstep.mjs --diff <file>           # read a unified diff from <file> (or - for stdin)
//   echo "<diff>" | node gate-contract-lockstep.mjs --diff -
//
// Output: { ok, pass, changedFiles, shapesTouched, findings:[{shape, kind, sides_present, sides_missing}] }
// Exit 1 if ANY side missing for ANY touched shape (gate block); exit 0 if all touched shapes are whole
// (including the trivial "nothing touched a contract shape" case — a clean empty result is a pass).
//
// GRACEFUL DEGRADATION: every seam is optional. A glob that matches nothing, an absent file, git not
// being present, an empty changed set, or a missing config key all produce a clean partial/empty result
// and exit 0 — never a stack trace. A fresh repo with no services and no portal still runs clean.

import { readFileSync, readdirSync } from 'node:fs';
import { loadConfig, tryGit, matchesAny, out, args } from './lib.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Tiny fs helpers that never throw — read returns '' on any failure; a glob walk
// returns [] when the root is absent. Cross-platform (always normalize to '/').
// ─────────────────────────────────────────────────────────────────────────────
function norm(p) { return String(p).replace(/\\/g, '/'); }

function safeRead(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

// Added lines parsed out of a `--diff` blob, keyed by file. Lets the gate see post-apply
// content even when the diff has NOT yet been applied to the working tree (the real S7
// flow applies first, so on-disk already reflects it — this is belt-and-suspenders for a
// "lint this diff before applying" call). Empty for the file-list / git-default modes.
const DIFF_ADDED = new Map();

// Content to extract a changed file's shapes from: on-disk text (post-apply, the S7 norm)
// PLUS any added-lines captured from a --diff blob for that file. Either source may be ''.
function contentOf(file) {
  const onDisk = safeRead(file);
  const added = DIFF_ADDED.get(norm(file)) || '';
  if (!added) return onDisk;
  return onDisk + '\n' + added;
}

// Resolve a config glob like "services/*-rs/src/routes/**/*.rs" to concrete files
// by listing the repo tree once (via git when available, else a node fs walk) and
// matching with lib's matchesAny. Both paths degrade to [] cleanly.
let _treeCache = null;
function repoTree() {
  if (_treeCache) return _treeCache;
  // Prefer git ls-files (fast, respects .gitignore, includes tracked files). Fall
  // back to a manual walk for a non-git checkout or a fresh repo. Either way → [].
  const g = tryGit('ls-files');
  if (g.ok && typeof g.out === 'string' && g.out.length) {
    _treeCache = g.out.split('\n').map(norm).filter(Boolean);
    return _treeCache;
  }
  // git absent / empty index — walk the cwd with node builtins.
  _treeCache = walk('.');
  return _treeCache;
}

function walk(root) {
  const acc = [];
  const skip = new Set(['.git', 'node_modules', 'target', '.next', 'dist', '.agents']);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') && skip.has(e.name)) continue;
      if (skip.has(e.name)) continue;
      const full = dir === '.' ? e.name : `${dir}/${e.name}`;
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) acc.push(norm(full));
    }
  }
  return acc;
}

// lib's globToRegex turns `**/` into `.*/`, which REQUIRES at least one intermediate
// directory — so `dir/**/*.rs` misses a file sitting directly in `dir/` (e.g. routes
// are registered in `routes/mod.rs` and `routes/nearby.rs`, no sub-dir). We can't edit
// lib, so for any `**/`-bearing glob we also try the zero-depth collapse (`**/ ` removed)
// so both depths match. Returns the expanded variant list for a single glob string.
function expandGlob(glob) {
  const variants = new Set([glob]);
  if (glob.includes('**/')) variants.add(glob.replace(/\*\*\//g, ''));
  return [...variants];
}

function filesMatchingGlob(glob) {
  if (typeof glob !== 'string' || !glob) return [];
  const variants = expandGlob(glob);
  return repoTree().filter((f) => safeMatchesAny(f, variants));
}

// matchesAny can in principle throw on a malformed (non-string) glob entry; keep
// the gate fail-soft (a bad extractor config must not crash the whole run).
function safeMatchesAny(path, patterns) {
  try { return matchesAny(path, patterns); } catch { return false; }
}

// Does `file` match `glob`, accounting for the `**/` zero-depth collapse (see expandGlob)?
// Single entry point so the changed-set "is this file in this seam" checks behave identically
// to the full-repo `filesMatchingGlob` walk.
function globMatch(file, glob) {
  if (typeof glob !== 'string' || !glob) return false;
  return safeMatchesAny(file, expandGlob(glob));
}

// ─────────────────────────────────────────────────────────────────────────────
// Changed-set resolution. Priority: --diff blob > explicit file args > git diff.
// Returns a de-duped list of forward-slash repo paths. Empty list is valid.
// ─────────────────────────────────────────────────────────────────────────────
function resolveChangedSet(argv) {
  // --diff <file|-> : parse a unified diff for its changed paths.
  const diffIdx = argv.indexOf('--diff');
  if (diffIdx !== -1) {
    const src = argv[diffIdx + 1];
    let blob = '';
    if (src === undefined || src === '-') {
      blob = readStdin();
    } else {
      blob = safeRead(src);
    }
    captureDiffAddedLines(blob); // populate DIFF_ADDED so unapplied diffs still extract
    return uniq(parseDiffPaths(blob));
  }

  // Explicit args (space-separated and/or comma-separated paths).
  const positional = argv.filter((a) => a !== '--diff');
  if (positional.length) {
    const parts = positional.flatMap((a) => String(a).split(','));
    return uniq(parts.map(norm).map((s) => s.trim()).filter(Boolean));
  }

  // Default: ask git for the working-tree + staged changes vs HEAD. tryGit never
  // throws; on a fresh repo with no HEAD this returns ok:false → empty set.
  const g = tryGit('diff --name-only HEAD');
  if (g.ok && typeof g.out === 'string' && g.out.length) {
    return uniq(g.out.split('\n').map(norm).map((s) => s.trim()).filter(Boolean));
  }
  return [];
}

function readStdin() {
  try {
    // fd 0; on Windows Git Bash this works for piped input. No pipe → '' (EAGAIN
    // throws, which we swallow). Synchronous read keeps the script dependency-free.
    return readFileSync(0, 'utf8');
  } catch { return ''; }
}

// Extract changed file paths from a unified diff. Handles `diff --git a/x b/x`,
// `+++ b/x`, and `--- a/x` forms; strips the a/ b/ prefixes; ignores /dev/null.
function parseDiffPaths(blob) {
  const paths = [];
  if (!blob) return paths;
  const lines = String(blob).replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    let m;
    if ((m = line.match(/^diff --git a\/(.+?) b\/(.+)$/))) {
      paths.push(m[2]);
    } else if ((m = line.match(/^\+\+\+ (?:b\/)?(.+)$/))) {
      if (!/\/dev\/null/.test(m[1])) paths.push(m[1].replace(/\t.*$/, ''));
    } else if ((m = line.match(/^--- (?:a\/)?(.+)$/))) {
      if (!/\/dev\/null/.test(m[1])) paths.push(m[1].replace(/\t.*$/, ''));
    }
  }
  return paths.map(norm).filter(Boolean);
}

// Walk a unified diff and record the ADDED lines (`+`, excluding the `+++` header) per file
// into DIFF_ADDED. The current file is tracked from `diff --git` / `+++ b/` headers. Lets the
// gate detect shapes introduced by a diff that hasn't been applied to the tree yet.
function captureDiffAddedLines(blob) {
  if (!blob) return;
  const lines = String(blob).replace(/\r\n/g, '\n').split('\n');
  let cur = null;
  for (const line of lines) {
    let m;
    if ((m = line.match(/^diff --git a\/(.+?) b\/(.+)$/))) {
      cur = norm(m[2]);
    } else if ((m = line.match(/^\+\+\+ (?:b\/)?(.+)$/))) {
      cur = /\/dev\/null/.test(m[1]) ? null : norm(m[1].replace(/\t.*$/, ''));
    } else if (line.startsWith('+') && !line.startsWith('+++') && cur) {
      const prev = DIFF_ADDED.get(cur) || '';
      DIFF_ADDED.set(cur, prev + line.slice(1) + '\n');
    }
  }
}

function uniq(arr) { return [...new Set(arr)]; }

// Concatenated diff-added text for every DIFF_ADDED file matching `glob`. Folds unapplied
// diff content into a side index so an added emitter/route/migration line counts as that
// side being PRESENT. Empty when no --diff was given or nothing matches.
function diffAddedForGlob(glob) {
  if (typeof glob !== 'string' || !glob || DIFF_ADDED.size === 0) return '';
  let text = '';
  for (const [file, added] of DIFF_ADDED) {
    if (globMatch(file, glob)) text += '\n' + added;
  }
  return text;
}

// Diff-added text for a single specific file (fanout file, portal file, ui file).
function diffAddedForFile(file) {
  if (typeof file !== 'string' || !file) return '';
  return DIFF_ADDED.get(norm(file)) || '';
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENT shape extraction.
//   A detail-type is the canonical "Aggregate.Action" string (CLAUDE.md §13/§14).
//   sides:
//     emitter — any *-rs service source string-literals the detail-type
//     fanout  — the signalr fanout router string-literals the detail-type
//     portal  — the portal subscriber registers conn.on('<camelCaseTarget>') for it
//   The portal target is the camelCase form of the detail-type's dotted name, which
//   is the locked convention in CLAUDE.md §14's routing table (ShiftAssignment.Confirmed
//   → shiftAssignmentConfirmed). We derive it deterministically so a new event with no
//   portal handler is detectable without a second config seam.
// ─────────────────────────────────────────────────────────────────────────────
// A detail-type literal is the QUOTED "Aggregate.Action" form — events are always passed
// as string literals (detail_type("ShiftAssignment.Confirmed"), route("Checkpoint.Missed")).
// Restricting to quoted strings drops a whole class of code-token noise (Duration.minutes,
// StatusCode.OK, self.foo) without a brittle keyword denylist. Both segments PascalCase.
const QUOTED_DETAIL_TYPE_RE = /["'`]([A-Z][A-Za-z0-9]+\.[A-Z][A-Za-z0-9]+)["'`]/g;

// Rust unit tests (`#[cfg(test)] mod tests { ... }`) reference fixture detail-types like
// "Random.NoHubMapping" that are deliberately NOT real events — stripping the test module
// before extraction avoids flagging a fixture as a lockstep gap. Best-effort brace match;
// if we can't find the closing brace we leave the text intact (fail-soft, never throws).
function stripRustTestModules(text) {
  if (!text || !text.includes('#[cfg(test)]')) return text;
  let s = String(text);
  let guard = 0;
  for (;;) {
    if (guard++ > 50) break;
    const at = s.indexOf('#[cfg(test)]');
    if (at === -1) break;
    const braceStart = s.indexOf('{', at);
    if (braceStart === -1) { s = s.slice(0, at); break; }
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < s.length; i++) {
      const ch = s[i];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) { s = s.slice(0, at); break; }
    s = s.slice(0, at) + s.slice(end + 1);
  }
  return s;
}

function detailTypesIn(text) {
  const found = new Set();
  if (!text) return found;
  const scrubbed = stripRustTestModules(text);
  let m;
  QUOTED_DETAIL_TYPE_RE.lastIndex = 0;
  while ((m = QUOTED_DETAIL_TYPE_RE.exec(scrubbed)) !== null) {
    found.add(m[1]);
  }
  return found;
}

// Map a dotted detail-type to its locked portal target method (camelCase of the joined
// segments): "ShiftAssignment.Confirmed" -> "shiftAssignmentConfirmed".
function portalTargetOf(detailType) {
  const joined = detailType.replace(/\./g, '');
  return joined.charAt(0).toLowerCase() + joined.slice(1);
}

function buildEventIndex(cfg) {
  const ev = (cfg.extractors && cfg.extractors.eventLockstep) || {};
  const emitterGlob = ev.emitter && ev.emitter.glob;
  const fanoutFile = ev.fanout;
  const portalFile = ev.portal;

  // Concatenate all emitter-glob files' contents (degrades to '' on no match). Fold in any
  // diff-added content for emitter-matching files so an unapplied "added emitter" counts.
  const emitterFiles = emitterGlob ? filesMatchingGlob(emitterGlob) : [];
  let emitterText = '';
  for (const f of emitterFiles) emitterText += '\n' + safeRead(f);
  emitterText += '\n' + diffAddedForGlob(emitterGlob);

  const fanoutText = (typeof fanoutFile === 'string' ? safeRead(fanoutFile) : '') + '\n' + diffAddedForFile(fanoutFile);
  const portalText = (typeof portalFile === 'string' ? safeRead(portalFile) : '') + '\n' + diffAddedForFile(portalFile);

  return {
    emitterGlob,
    emitterFiles,
    fanoutFile,
    portalFile,
    fanoutConfigured: typeof fanoutFile === 'string' && fanoutFile.length > 0,
    portalConfigured: typeof portalFile === 'string' && portalFile.length > 0,
    emitterText,
    fanoutText,
    portalText,
    emitterDetailTypes: detailTypesIn(emitterText),
    fanoutDetailTypes: detailTypesIn(fanoutText),
    // Portal side is keyed by the camelCase target, registered via conn.on('x') /
    // .on("x"). Collect the registered target identifiers.
    portalTargets: portalTargetsIn(portalText),
  };
}

function portalTargetsIn(text) {
  const found = new Set();
  if (!text) return found;
  // conn.on('shiftAssignmentConfirmed', ...) or .on("checkpointMissed", ...)
  const re = /\.on\(\s*['"]([A-Za-z0-9_]+)['"]/g;
  let m;
  while ((m = re.exec(text)) !== null) found.add(m[1]);
  return found;
}

// Which event detail-types did the CHANGED SET touch? A changed file touches an event
// shape if it is the emitter glob / fanout file / portal file AND it string-literals a
// detail-type (or, for portal, a known target). We re-extract from the changed files
// specifically so an unrelated event already in the repo isn't re-litigated.
function eventShapesTouched(changedFiles, idx, cfg) {
  const ev = (cfg.extractors && cfg.extractors.eventLockstep) || {};
  const touched = new Set();

  for (const f of changedFiles) {
    // emitter or fanout: any dotted detail-type in the changed file
    const isEmitter = idx.emitterGlob && globMatch(f, idx.emitterGlob);
    const isFanout = idx.fanoutFile && norm(idx.fanoutFile) === f;
    const isPortal = idx.portalFile && norm(idx.portalFile) === f;
    if (!isEmitter && !isFanout && !isPortal) continue;

    const text = contentOf(f);
    if (isEmitter || isFanout) {
      for (const dt of detailTypesIn(text)) touched.add(dt);
    }
    if (isPortal) {
      // Map each changed portal target back to a candidate detail-type by reverse
      // lookup against detail-types known anywhere (emitter ∪ fanout). A target with
      // no known detail-type is still surfaced (its detail-type is the target name).
      const known = new Set([...idx.emitterDetailTypes, ...idx.fanoutDetailTypes]);
      const byTarget = new Map();
      for (const dt of known) byTarget.set(portalTargetOf(dt), dt);
      for (const t of portalTargetsIn(text)) {
        touched.add(byTarget.get(t) || `?.${t}`); // unknown → synthetic shape, still checked
      }
    }
  }
  // Drop obvious config/aggregate-suffix false positives that aren't real domain events:
  // require the detail-type to appear in at least one of the three sides somewhere, OR be
  // a synthetic portal-only "?." shape (which is itself a finding: portal handler, no event).
  const out = new Set();
  for (const dt of touched) {
    if (dt.startsWith('?.')) { out.add(dt); continue; }
    if (idx.emitterDetailTypes.has(dt) || idx.fanoutDetailTypes.has(dt)) out.add(dt);
    // else: a dotted token in a changed emitter/fanout file that isn't actually present
    // in the assembled side text (e.g. only in a comment that got filtered) — skip noise.
    else if (detailTypesIn(idx.emitterText).has(dt) || detailTypesIn(idx.fanoutText).has(dt)) out.add(dt);
  }
  return out;
}

function checkEventShape(detailType, idx) {
  const sidesPresent = [];
  const sidesMissing = [];
  if (detailType.startsWith('?.')) {
    // Portal handler exists for a target with no matching emitter/fanout detail-type.
    const target = detailType.slice(2);
    sidesPresent.push('portal');
    sidesMissing.push('emitter', 'fanout');
    return {
      shape: `event:${target} (portal handler, no matching emitter/fanout detail-type)`,
      kind: 'event',
      sides_present: sidesPresent,
      sides_missing: sidesMissing,
    };
  }
  const target = portalTargetOf(detailType);
  (idx.emitterDetailTypes.has(detailType) ? sidesPresent : sidesMissing).push('emitter');
  (idx.fanoutDetailTypes.has(detailType) ? sidesPresent : sidesMissing).push('fanout');
  (idx.portalTargets.has(target) ? sidesPresent : sidesMissing).push('portal');
  return {
    shape: `event:${detailType}`,
    kind: 'event',
    sides_present: sidesPresent,
    sides_missing: sidesMissing,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE shape extraction.
//   sides:
//     handler — a backend route file registers the path via .route("/x", ...)
//     ui      — the portal api-client references the path string
//   We key the shape on the route path literal (e.g. "/guards/nearby"). UI presence is
//   a substring match of the path in the api-client file (paths are passed to apiFetch
//   as string literals like apiFetch('/guards/nearby')). Path params (`/guards/:id`,
//   `/guards/{id}`) are normalized to a stable prefix so the UI's templated form matches.
// ─────────────────────────────────────────────────────────────────────────────
function routePathsIn(text) {
  const found = new Set();
  if (!text) return found;
  // axum .route("/path", ...) and Router::new().route("/path"...). Capture the literal.
  const re = /\.route\(\s*["'`]([^"'`]+)["'`]/g;
  let m;
  while ((m = re.exec(text)) !== null) found.add(m[1]);
  return found;
}

// Normalize a route path to its static prefix (everything up to the first param segment),
// so "/guards/:id/certifications" and the UI's `/guards/${id}/certifications` both reduce
// to a comparable key, and a UI substring check on the static head still matches.
function routeStaticPrefix(path) {
  const segs = String(path).split('/');
  const out = [];
  for (const s of segs) {
    if (s.startsWith(':') || (s.startsWith('{') && s.endsWith('}'))) break;
    out.push(s);
  }
  let p = out.join('/');
  if (!p.startsWith('/') && path.startsWith('/')) p = '/' + p.replace(/^\/+/, '');
  return p || path;
}

// The UI side of a route can legitimately live in ANY portal component that imports the
// api-client wrapper — not only in api-client.ts itself (e.g. /guards/nearby is fetched
// from geofencing/dynamic-map.tsx via apiFetch('/guards/nearby?...')). Checking only the
// single configured file would falsely block a route that IS wired, just from a component.
// So the UI corpus = the configured uiCallSites file/glob PLUS the .ts/.tsx tree under the
// nearest `src/` ancestor of that file. The config path is still the only seam — the src/
// root is DERIVED from it, nothing repo-specific is hardcoded. Degrades to just the file
// (or empty) when no src/ ancestor exists.
function uiCorpusFiles(ui) {
  const files = new Set();
  const file = ui && ui.file;
  const glob = ui && ui.glob;
  if (typeof glob === 'string' && glob) {
    for (const f of filesMatchingGlob(glob)) files.add(f);
  }
  if (typeof file === 'string' && file) {
    const nf = norm(file);
    files.add(nf);
    // Derive the src/ root: take everything up to and including the last `src/` segment.
    const parts = nf.split('/');
    const srcIdx = parts.lastIndexOf('src');
    if (srcIdx !== -1) {
      const root = parts.slice(0, srcIdx + 1).join('/');
      for (const f of repoTree()) {
        if ((f.startsWith(root + '/') || f === root) && /\.(ts|tsx|js|jsx)$/.test(f)) files.add(f);
      }
    }
  }
  return [...files];
}

function buildRouteIndex(cfg) {
  const br = (cfg.extractors && cfg.extractors.backendRoutes) || {};
  const ui = (cfg.extractors && cfg.extractors.uiCallSites) || {};
  const backendGlob = br.glob;
  const uiFile = ui.file;

  const backendFiles = backendGlob ? filesMatchingGlob(backendGlob) : [];
  let backendText = '';
  for (const f of backendFiles) backendText += '\n' + safeRead(f);
  backendText += '\n' + diffAddedForGlob(backendGlob);

  const uiFiles = uiCorpusFiles(ui);
  let uiText = '';
  for (const f of uiFiles) uiText += '\n' + safeRead(f);
  // Fold diff-added UI content (any changed .ts/.tsx) so an unapplied UI call site counts.
  for (const [file, added] of DIFF_ADDED) {
    if (/\.(ts|tsx|js|jsx)$/.test(file)) uiText += '\n' + added;
  }

  return {
    backendGlob,
    backendFiles,
    uiFile,
    uiFiles,
    backendText,
    uiText,
    backendPaths: routePathsIn(backendText),
  };
}

function routeShapesTouched(changedFiles, idx) {
  const touched = new Set();
  const uiSet = new Set(idx.uiFiles || []);
  for (const f of changedFiles) {
    const isBackend = idx.backendGlob && globMatch(f, idx.backendGlob);
    const isUi = uiSet.has(f);
    if (isBackend) {
      for (const p of routePathsIn(contentOf(f))) touched.add(p);
    }
    if (isUi) {
      // A changed UI file surfaces which backend route paths its strings reference;
      // we re-check those against the backend route table. Match each known backend
      // path whose static prefix appears in the changed UI text.
      const uiText = contentOf(f);
      for (const p of idx.backendPaths) {
        if (uiText.includes(routeStaticPrefix(p))) touched.add(p);
      }
    }
  }
  return touched;
}

function checkRouteShape(path, idx) {
  const sidesPresent = [];
  const sidesMissing = [];
  (idx.backendPaths.has(path) ? sidesPresent : sidesMissing).push('handler');
  const prefix = routeStaticPrefix(path);
  const uiHas = idx.uiText && (idx.uiText.includes(path) || idx.uiText.includes(prefix));
  (uiHas ? sidesPresent : sidesMissing).push('ui');
  return {
    shape: `route:${path}`,
    kind: 'route',
    sides_present: sidesPresent,
    sides_missing: sidesMissing,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION shape extraction.
//   A migration shape is keyed on a (table, column) added by the migration. sides:
//     column     — the migration ADDs/declares the column (ADD COLUMN / CREATE TABLE col)
//     constraint — a DB-level constraint references the column anywhere in the migration
//                   set for that table (CHECK / FOREIGN KEY/REFERENCES / UNIQUE / NOT NULL /
//                   PRIMARY KEY / ENUM type / generated). DB-constraint principle (CLAUDE.md).
//     model      — a backend source references the column name (query string / serde field).
//   Per the registry "migration-no-model" detector: a column never referenced by a query/
//   serde struct OR missing its DB constraint is the orphan. Lockstep = all three present.
// ─────────────────────────────────────────────────────────────────────────────

// Extract ADDED columns from a migration's SQL text. Returns [{table, column, line}].
// Handles `ALTER TABLE x.y ADD COLUMN [IF NOT EXISTS] col TYPE ...` and, best-effort,
// columns declared in a `CREATE TABLE x.y ( col TYPE, ... )` block.
function addedColumnsIn(text) {
  const cols = [];
  if (!text) return cols;
  const sql = String(text).replace(/\r\n/g, '\n');

  // ALTER TABLE ... ADD COLUMN
  const addRe = /ALTER\s+TABLE\s+([A-Za-z0-9_.]+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/gi;
  let m;
  while ((m = addRe.exec(sql)) !== null) {
    cols.push({ table: m[1].toLowerCase(), column: m[2].toLowerCase() });
  }

  // CREATE TABLE block — pull the simple "col TYPE" leading tokens of each line inside
  // the first parenthesized body. Best-effort; constraint-only lines are skipped.
  const ctRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_.]+)\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
  let c;
  while ((c = ctRe.exec(sql)) !== null) {
    const table = c[1].toLowerCase();
    const body = c[2];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim().replace(/,$/, '');
      if (!line) continue;
      // Skip table-level constraint declarations.
      if (/^(CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|EXCLUDE|LIKE)\b/i.test(line)) continue;
      const cm = line.match(/^([A-Za-z0-9_]+)\s+/);
      if (cm) cols.push({ table, column: cm[1].toLowerCase() });
    }
  }
  return dedupeCols(cols);
}

function dedupeCols(cols) {
  const seen = new Set();
  const out = [];
  for (const c of cols) {
    const k = `${c.table}.${c.column}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

// Does the assembled migration text carry a DB-level constraint that mentions this column?
// We accept any of: NOT NULL on the column line, REFERENCES (FK), a CHECK referencing it,
// a UNIQUE/PRIMARY KEY on it, the column being a recognized ENUM type, or a generated column.
function columnHasConstraint(table, column, migText) {
  if (!migText) return false;
  const sql = String(migText).replace(/\r\n/g, '\n');
  const col = column.toLowerCase();

  // 1) Inline on an ADD COLUMN / CREATE TABLE column line: NOT NULL, REFERENCES, UNIQUE,
  //    PRIMARY KEY, CHECK (...), GENERATED, or an ENUM-typed column.
  const lineRe = new RegExp(
    `(?:ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?|^\\s*)${escapeRe(col)}\\s+[^\\n,]*`,
    'gmi',
  );
  let m;
  while ((m = lineRe.exec(sql)) !== null) {
    const seg = m[0];
    if (/\bNOT\s+NULL\b/i.test(seg)) return true;
    if (/\bREFERENCES\b/i.test(seg)) return true;
    if (/\bUNIQUE\b/i.test(seg)) return true;
    if (/\bPRIMARY\s+KEY\b/i.test(seg)) return true;
    if (/\bCHECK\s*\(/i.test(seg)) return true;
    if (/\bGENERATED\b/i.test(seg)) return true;
    // ENUM-typed: the column's type token is a known *_status / *_enum / declared TYPE.
    if (/\b[a-z0-9_]*(?:status|enum|_type|level|method|channel|severity)\b/i.test(seg)) return true;
  }

  // 2) Table-level / separate-statement constraints that name the column:
  //    ADD CONSTRAINT ... CHECK (col ...) / FOREIGN KEY (col) / UNIQUE (col)
  //    or a UNIQUE INDEX on the column. Bound the UNIQUE-INDEX span with [^;]*? (stays
  //    inside ONE statement) so a `CREATE UNIQUE INDEX` in an unrelated earlier migration
  //    can't lazily bridge to a later `(... col ...)` and produce a cross-statement false
  //    positive (the bug that let a plain `archived_at TIMESTAMPTZ` look constrained).
  const tableConstraintRes = [
    new RegExp(`CHECK\\s*\\([^)]*\\b${escapeRe(col)}\\b`, 'i'),
    new RegExp(`FOREIGN\\s+KEY\\s*\\([^)]*\\b${escapeRe(col)}\\b`, 'i'),
    new RegExp(`UNIQUE\\s*\\([^)]*\\b${escapeRe(col)}\\b`, 'i'),
    new RegExp(`PRIMARY\\s+KEY\\s*\\([^)]*\\b${escapeRe(col)}\\b`, 'i'),
    new RegExp(`CREATE\\s+UNIQUE\\s+INDEX[^;]*?\\([^)]*\\b${escapeRe(col)}\\b`, 'i'),
  ];
  if (tableConstraintRes.some((re) => re.test(sql))) return true;

  return false;
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function buildMigrationIndex(cfg) {
  const mg = (cfg.extractors && cfg.extractors.migrations) || {};
  const migGlob = mg.glob;
  const migFiles = migGlob ? filesMatchingGlob(migGlob) : [];
  let migText = '';
  for (const f of migFiles) migText += '\n' + safeRead(f);
  migText += '\n' + diffAddedForGlob(migGlob);

  // Backend source for the "model" side: every backend route glob file PLUS broader
  // *-rs/src tree. We reuse the route backend glob's directory by scanning all .rs under
  // services for column references (query strings / serde field names use snake_case col).
  const backendModelText = assembleBackendModelText(cfg);

  return {
    migGlob,
    migFiles,
    migText,
    backendModelText,
    // The model corpus is non-empty whenever any backend .rs exists OR a diff added .rs.
    backendModelPresent: backendModelText.trim().length > 0,
  };
}

// Assemble a corpus of backend source where a migration column would be "modeled":
// any Rust source under services/*-rs/src. Degrades to '' when none exist.
function assembleBackendModelText(cfg) {
  // Derive a service-source glob from the backendRoutes glob's service prefix when present,
  // else fall back to a conventional services/*-rs/src tree. Either way matchesAny→[].
  const br = (cfg.extractors && cfg.extractors.backendRoutes) || {};
  const globs = ['services/*-rs/src/**/*.rs', 'services/*/src/**/*.rs'];
  if (typeof br.glob === 'string') globs.push(br.glob);
  const tree = repoTree();
  const files = tree.filter((f) => globs.some((g) => globMatch(f, g)));
  let text = '';
  for (const f of uniq(files)) text += '\n' + safeRead(f);
  // Fold diff-added .rs content so a model reference introduced by an unapplied diff counts.
  for (const [file, added] of DIFF_ADDED) {
    if (/\.rs$/.test(file)) text += '\n' + added;
  }
  return text;
}

function migrationShapesTouched(changedFiles, idx) {
  const touched = []; // [{table, column}]
  const seen = new Set();
  for (const f of changedFiles) {
    if (!(idx.migGlob && globMatch(f, idx.migGlob))) continue;
    for (const c of addedColumnsIn(contentOf(f))) {
      const k = `${c.table}.${c.column}`;
      if (seen.has(k)) continue;
      seen.add(k);
      touched.push(c);
    }
  }
  return touched;
}

function checkMigrationShape(col, idx) {
  const sidesPresent = [];
  const sidesMissing = [];
  const key = `${col.table}.${col.column}`;

  // column side: by construction it WAS added by a changed migration → present. We still
  // re-confirm against the full migration text so a renamed/reverted column is honest.
  const columnPresent = addedColumnsIn(idx.migText).some(
    (c) => c.table === col.table && c.column === col.column,
  );
  (columnPresent ? sidesPresent : sidesMissing).push('column');

  // constraint side
  const hasConstraint = columnHasConstraint(col.table, col.column, idx.migText);
  (hasConstraint ? sidesPresent : sidesMissing).push('constraint');

  // model side: the column name appears in backend source (query string / serde field).
  // Match the bare snake_case column token on a word boundary.
  const colRe = new RegExp(`\\b${escapeRe(col.column)}\\b`);
  const modeled = colRe.test(idx.backendModelText);
  (modeled ? sidesPresent : sidesMissing).push('model');

  return {
    shape: `migration:${key}`,
    kind: 'migration',
    sides_present: sidesPresent,
    sides_missing: sidesMissing,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
function main() {
  const argv = args();
  const cfg = (() => {
    try { return loadConfig() || {}; } catch { return {}; }
  })();

  const changedFiles = resolveChangedSet(argv);

  // Build the full-repo side indexes once. Each is independently degradable: a missing
  // extractor key just yields an empty index, and a shape that can't find that side will
  // (correctly) report it missing — but only if the changed set actually TOUCHED that
  // shape. A changed set that never touches, say, an event emitter never produces an
  // event finding, so an absent portal file can't generate a false block.
  const eventIdx = buildEventIndex(cfg);
  const routeIdx = buildRouteIndex(cfg);
  const migIdx = buildMigrationIndex(cfg);

  const findings = [];

  // EVENT
  const eventsTouched = changedFiles.length ? eventShapesTouched(changedFiles, eventIdx, cfg) : new Set();
  for (const dt of eventsTouched) {
    const f = checkEventShape(dt, eventIdx);
    if (f.sides_missing.length) findings.push(f);
  }

  // ROUTE
  const routesTouched = changedFiles.length ? routeShapesTouched(changedFiles, routeIdx) : new Set();
  for (const p of routesTouched) {
    const f = checkRouteShape(p, routeIdx);
    if (f.sides_missing.length) findings.push(f);
  }

  // MIGRATION
  const migsTouched = changedFiles.length ? migrationShapesTouched(changedFiles, migIdx) : [];
  for (const c of migsTouched) {
    const f = checkMigrationShape(c, migIdx);
    if (f.sides_missing.length) findings.push(f);
  }

  const shapesTouched = {
    event: [...eventsTouched],
    route: [...routesTouched],
    migration: migsTouched.map((c) => `${c.table}.${c.column}`),
  };

  const pass = findings.length === 0;

  // Surface which seams were present so a degraded run is legible (e.g. portal file
  // absent → portal side can't be proven; the operator should know).
  const seams = {
    eventEmitterFiles: eventIdx.emitterFiles.length,
    eventFanout: eventIdx.fanoutConfigured,
    eventPortal: eventIdx.portalConfigured,
    backendRouteFiles: routeIdx.backendFiles.length,
    uiCorpusFiles: (routeIdx.uiFiles || []).length,
    migrationFiles: migIdx.migFiles.length,
    backendModel: migIdx.backendModelPresent,
  };

  out({
    ok: pass,
    pass,
    changedFiles: changedFiles.length,
    shapesTouched,
    seams,
    findings,
  });
  process.exit(pass ? 0 : 1);
}

main();
