#!/usr/bin/env node
// detect-route-no-ui.mjs — Layer-A detector "route-no-ui" (SCHEMA §5 route-no-UI; registry
// detectors[] { id:"route-no-ui", class:"orphan", emitsEdges:true }).
//
// `node detect-route-no-ui.mjs`
//   Extract the BACKEND route table (config.extractors.backendRoutes: a file glob + a router
//   pattern; we grep matching files for axum-style `.route("<path>", <method>(...))`
//   declarations) and the set of UI CALL SITES (endpoint path strings parsed out of the single
//   config.extractors.uiCallSites file). A backend route that NO UI call site reaches is a
//   finding (an orphan candidate). For routes that DO have a UI caller we emit a `routes_to`
//   edge (route -> ui_surface) so the system map gets the connected half of the same extraction.
//
//   Output:
//     {
//       findings: [{ route, method? }],                       // routes with no UI caller
//       edges:    [{ from:"<route>", from_kind:"route",
//                    to:"<ui>", to_kind:"ui_surface",
//                    edge:"routes_to", source_extractor:"route-no-ui",
//                    last_seen_commit }],
//       ...counts/degraded notes
//     }
//   Empty (no findings, no edges) when no backend routes are found — a fresh repo, an extractor
//   glob that matches nothing, or an absent uiCallSites file all degrade cleanly.
//
// CONTRACT (SCHEMA §5 + README): detectors are READ-ONLY (no Edit/Write to the tree) and REPORT
// — they NEVER block. So this script ALWAYS exits 0: empty/absent ledger is irrelevant here, but
// a missing config key, an absent file, a glob matching nothing, or git-absent must each produce
// a clean empty/partial result with a one-line `degraded` note, never a stack trace. Every
// repo-specific value (which glob, which pattern, which UI file) is read from config — nothing
// repo-specific is hardcoded.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  tryGit, matchesAny, ok, existsSync, CONFIG_PATH,
} from './lib.mjs';

// --- safe IO -----------------------------------------------------------------------

// Read a file's text, tolerating absence / permission / binary issues. Returns null on any
// failure so callers degrade instead of throwing.
function readTextSafe(path) {
  try { return readFileSync(path, 'utf8'); }
  catch { return null; }
}

// Recursively list every file under a root, returning repo-relative forward-slashed paths so
// they can be matched against the config glob with lib.matchesAny. Never throws: an unreadable
// dir / a vanished entry / a symlink loop guard all degrade to "skip this branch". Caps total
// visited entries so a pathological tree can't spin forever.
function walkFiles(root, { cap = 200000 } = {}) {
  const out = [];
  if (!root || !existsSync(root)) return out;
  const stack = [root];
  const seenDirs = new Set();
  let visited = 0;
  while (stack.length > 0) {
    if (visited >= cap) break;
    const dir = stack.pop();
    // Guard against symlink-induced revisits.
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { continue; } // unreadable dir -> skip the branch, keep walking the rest
    for (const ent of entries) {
      visited += 1;
      if (visited >= cap) break;
      const full = join(dir, ent.name);
      let isDir = false;
      let isFile = false;
      try {
        // withFileTypes gives us the type without an extra stat in the common case; fall back
        // to statSync only for symlinks (whose Dirent type is "link", not file/dir).
        if (ent.isDirectory()) isDir = true;
        else if (ent.isFile()) isFile = true;
        else if (ent.isSymbolicLink()) {
          const st = statSync(full); // resolves the link; throws on a dangling link -> caught
          isDir = st.isDirectory();
          isFile = st.isFile();
        }
      } catch { continue; } // dangling symlink / race -> skip this entry
      if (isDir) stack.push(full);
      else if (isFile) out.push(full.replace(/\\/g, '/'));
    }
  }
  return out;
}

// lib.globToRegex compiles `**/` to `.*/` — which REQUIRES at least one intermediate directory
// separator, so a file sitting DIRECTLY in the `**` position (e.g. ".../routes/guards.rs" against
// ".../routes/**/*.rs") fails to match even though `**` is meant to span zero-or-more dirs. We do
// not edit lib (it's shared). Instead we expand a glob into the variants we want matchesAny to OR
// over: the original (matches one-or-more intervening dirs) PLUS each form with a `**/` segment
// elided (matches zero intervening dirs). This keeps all globbing inside lib.matchesAny and still
// reads the pattern from config — we only widen which paths count as a match, never narrow it.
function globVariants(glob) {
  const g = String(glob || '');
  const variants = new Set([g]);
  // Elide each `**/` occurrence (and a leading `**/`) to allow the zero-directory case.
  if (g.includes('**/')) {
    variants.add(g.replace(/\*\*\//g, ''));     // all `**/` -> "" (zero dirs everywhere)
    // Also a form where only the trailing `**/` collapses, leaving earlier ones intact, so a
    // glob with multiple `**/` still matches a file at any of the spanned depths.
    variants.add(g.replace(/\*\*\/([^/]*)$/, '$1'));
  }
  return [...variants];
}

// Determine the static prefix of a glob — the leading path segments before the first wildcard.
// We only walk from there (and the repo root as a fallback) so we don't scan the entire tree.
// e.g. "services/*-rs/src/routes/**/*.rs" -> "services". A glob with a wildcard in segment 0
// (or no slash) yields "." so we walk from cwd. Never throws.
function globWalkRoot(glob) {
  const g = String(glob || '').replace(/\\/g, '/');
  const segs = g.split('/');
  const stable = [];
  for (const s of segs) {
    if (s.includes('*') || s.includes('?') || s.includes('[')) break;
    stable.push(s);
  }
  const root = stable.join('/');
  return root.length > 0 ? root : '.';
}

// --- backend route extraction ------------------------------------------------------

// Pull axum-style route paths out of one Rust source file. We look for `.route("<path>", ...)`
// (the canonical axum declaration). The method (get|post|patch|put|delete) is captured when it
// appears as a routing combinator on the same logical `.route(...)` call, e.g.
//   .route("/guards", get(list).post(create))
// We surface ONE finding per (path, method) seen, but the path is what matters for UI matching.
// The config pattern (config.extractors.backendRoutes.pattern) decides whether a FILE is a
// router file worth scanning; the per-route regex below does the actual path extraction (the
// config pattern — `.route(|.nest(|Router::new` — is a coarse "is this a router module" gate).
const ROUTE_RE = /\.route\(\s*(["'])((?:\\.|(?!\1).)*)\1\s*,([^;]*?)\)\s*(?:;|\.route\(|\.merge\(|\.nest\(|\.layer\(|\.with_state\(|\.fallback\()/gs;
// Fallback (simpler) capture: just the path literal in any `.route("...")`, for files whose
// chaining shape the greedy form above doesn't terminate on. Method left undefined.
const ROUTE_PATH_RE = /\.route\(\s*(["'])((?:\\.|(?!\1).)*)\1/g;
const METHOD_RE = /\b(get|post|put|patch|delete|head|options|trace)\s*\(/g;

function extractRoutesFromText(text) {
  const found = [];
  if (typeof text !== 'string' || text.length === 0) return found;

  // Primary pass: path + the argument blob after the comma, from which we read HTTP methods.
  let m;
  ROUTE_RE.lastIndex = 0;
  const seenSpans = new Set();
  while ((m = ROUTE_RE.exec(text)) !== null) {
    const path = m[2];
    const argBlob = m[3] || '';
    seenSpans.add(path + '::' + (m.index));
    const methods = new Set();
    let mm;
    METHOD_RE.lastIndex = 0;
    while ((mm = METHOD_RE.exec(argBlob)) !== null) methods.add(mm[1].toUpperCase());
    if (methods.size === 0) {
      found.push({ route: path, method: undefined });
    } else {
      for (const meth of methods) found.push({ route: path, method: meth });
    }
    // Avoid pathological backtracking on a zero-width match.
    if (ROUTE_RE.lastIndex === m.index) ROUTE_RE.lastIndex += 1;
  }

  // Fallback pass: catch any `.route("path")` whose surrounding chain the primary regex didn't
  // bracket (so no route literal is ever dropped). Only add paths not already captured.
  const havePaths = new Set(found.map((f) => f.route));
  ROUTE_PATH_RE.lastIndex = 0;
  while ((m = ROUTE_PATH_RE.exec(text)) !== null) {
    const path = m[2];
    if (!havePaths.has(path)) {
      found.push({ route: path, method: undefined });
      havePaths.add(path);
    }
    if (ROUTE_PATH_RE.lastIndex === m.index) ROUTE_PATH_RE.lastIndex += 1;
  }
  return found;
}

// --- UI call-site extraction -------------------------------------------------------

// Parse endpoint path strings out of the UI call-site file. This is a typed fetch wrapper +
// the callers' string literals; we want every literal that LOOKS like an API path so we can
// test whether a backend route is reached. We accept:
//   - plain string literals beginning with "/" :  '/guards', "/audit-logs", `/guards/${id}`
//   - inside template literals, the LEADING static run after the opening backtick if it starts
//     with "/" (so `/guards/${id}/certifications` contributes the prefix "/guards/").
// We deliberately keep the leading path segment(s); query strings (?x=) and trailing template
// interpolations are trimmed so a concrete `/guards/abc123` and a templated `/guards/${id}`
// both reduce to the same comparable prefix as the axum `/guards/:id`.
const UI_STRING_RE = /(["'`])((?:\\.|(?!\1).)*)\1/g;

function extractUiPaths(text) {
  const paths = new Set();
  if (typeof text !== 'string' || text.length === 0) return paths;
  let m;
  UI_STRING_RE.lastIndex = 0;
  while ((m = UI_STRING_RE.exec(text)) !== null) {
    let lit = m[2];
    if (UI_STRING_RE.lastIndex === m.index) UI_STRING_RE.lastIndex += 1;
    if (typeof lit !== 'string') continue;
    // For a template literal, only the leading static run (up to the first ${) is a usable
    // literal; everything after the first interpolation is dynamic.
    const interp = lit.indexOf('${');
    if (interp !== -1) lit = lit.slice(0, interp);
    // Drop a query string / fragment — they aren't part of the route path.
    lit = lit.split('?')[0].split('#')[0];
    lit = lit.trim();
    // Only keep things that look like an API path: must start with "/" and not be a protocol
    // (//host) or a bare slash. Reject ones with whitespace (prose) or obvious non-path chars.
    if (!lit.startsWith('/')) continue;
    if (lit.startsWith('//')) continue;
    if (lit.length < 2) continue;
    if (/\s/.test(lit)) continue;
    paths.add(lit);
  }
  return paths;
}

// --- route <-> UI matching ---------------------------------------------------------

// Normalize a path into comparable lower-cased segments, mapping axum/UI dynamic segments to a
// single wildcard token. axum params look like ":id" / "*rest"; concrete UI ids and template
// interpolation remnants are treated as wildcards too. A trailing empty segment (from a
// trailing slash) is dropped.
function segmentsOf(path) {
  const clean = String(path).split('?')[0].split('#')[0];
  const parts = clean.split('/').filter((s) => s.length > 0);
  return parts.map((seg) => {
    if (seg.startsWith(':') || seg.startsWith('*')) return '*'; // axum param
    return seg.toLowerCase();
  });
}

// Does a UI call-site path REACH this backend route? True when, segment by segment, the route
// is a prefix of (or equal to) the UI path and every position is either equal or matched by a
// wildcard on the ROUTE side (the route's `:id` accepts any concrete UI segment). A UI path
// longer than the route still counts as reaching it (e.g. UI `/guards/abc/certifications`
// reaches route `/guards/:id/certifications`; UI `/guards/abc` reaches `/guards/:id`). We require
// the route to be fully consumed — the UI path must cover at least every route segment.
function uiReachesRoute(uiSegs, routeSegs) {
  if (routeSegs.length === 0) {
    // Root route "/" — reached by any UI path that is also root, or any path at all? Be strict:
    // only an exactly-root UI path reaches a root route.
    return uiSegs.length === 0;
  }
  if (uiSegs.length < routeSegs.length) return false;
  for (let i = 0; i < routeSegs.length; i += 1) {
    const r = routeSegs[i];
    const u = uiSegs[i];
    if (r === '*') continue;            // route param accepts anything the UI put here
    if (u === '*') continue;            // UI dynamic segment could be this literal — be lenient
    if (r !== u) return false;
  }
  return true;
}

// --- main --------------------------------------------------------------------------

// Load the config WITHOUT lib.loadConfig(): that helper calls fail()/process.exit(1) (it does
// NOT throw) when the config file is absent or corrupt, which would make this detector BLOCK — a
// violation of the detector contract (SCHEMA §5: report, never block) and the fresh-repo
// portability guarantee (every script must run on a repo with no data, exit 0). So we read the
// same CONFIG_PATH lib resolves, and degrade cleanly on absent/unreadable/corrupt config. We
// still read every repo-specific value from this config — nothing repo-specific is hardcoded.
function loadConfigSafe() {
  if (!existsSync(CONFIG_PATH)) {
    return { config: null, warning: `config not found at ${CONFIG_PATH} — fresh repo / unconfigured; no extraction` };
  }
  let raw;
  try { raw = readFileSync(CONFIG_PATH, 'utf8'); }
  catch (e) { return { config: null, warning: `config unreadable at ${CONFIG_PATH}: ${(e && e.message) || e}` }; }
  try { return { config: JSON.parse(raw), warning: null }; }
  catch (e) { return { config: null, warning: `config parse error at ${CONFIG_PATH}: ${(e && e.message) || e}` }; }
}

function main() {
  const { config, warning: configWarning } = loadConfigSafe();
  const extractors = (config && config.extractors) || {};
  const backendCfg = extractors.backendRoutes || {};
  const uiCfg = extractors.uiCallSites || {};

  const backendGlob = typeof backendCfg.glob === 'string' ? backendCfg.glob : null;
  const backendPattern = typeof backendCfg.pattern === 'string' ? backendCfg.pattern : null;
  const uiFile = typeof uiCfg.file === 'string' ? uiCfg.file : null;

  const degraded = [];
  if (configWarning) degraded.push(configWarning);

  // Resolve the current commit for edge provenance. tryGit never throws; degrade to null.
  const headRes = tryGit('rev-parse HEAD');
  const lastSeenCommit = headRes.ok ? headRes.out.trim() : null;
  if (!headRes.ok) degraded.push('git unavailable — last_seen_commit is null');

  // --- 1) backend routes -----------------------------------------------------------
  let routes = []; // [{ route, method? }]
  let routeFilesScanned = 0;
  if (!backendGlob) {
    degraded.push('config.extractors.backendRoutes.glob missing — no routes extracted');
  } else {
    // Compile the "is this a router module" pattern from config. If it's an invalid regex,
    // degrade to scanning every matched file (the per-route regex still does real work).
    let routerGate = null;
    if (backendPattern) {
      try { routerGate = new RegExp(backendPattern); }
      catch (e) { degraded.push(`backendRoutes.pattern is not a valid regex (${(e && e.message) || e}) — gate skipped`); }
    }
    const walkRoot = globWalkRoot(backendGlob);
    const globMatchers = globVariants(backendGlob); // original + `**/`-elided forms
    const candidates = walkFiles(walkRoot).filter((p) => matchesAny(p, globMatchers));
    const seen = new Set(); // dedupe (route + method) across files
    for (const file of candidates) {
      const text = readTextSafe(file);
      if (text === null) continue;
      // Coarse gate: only treat files that look like router modules as route sources.
      if (routerGate && !routerGate.test(text)) continue;
      routeFilesScanned += 1;
      for (const r of extractRoutesFromText(text)) {
        const key = `${r.route}::${r.method || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        routes.push(r);
      }
    }
  }

  // --- 2) UI call sites ------------------------------------------------------------
  let uiPaths = new Set();
  if (!uiFile) {
    degraded.push('config.extractors.uiCallSites.file missing — every route counts as orphan');
  } else if (!existsSync(uiFile)) {
    degraded.push(`uiCallSites file not found: ${uiFile} — every route counts as orphan`);
  } else {
    const text = readTextSafe(uiFile);
    if (text === null) degraded.push(`uiCallSites file unreadable: ${uiFile}`);
    else uiPaths = extractUiPaths(text);
  }

  // Precompute UI segment lists once.
  const uiSegLists = [...uiPaths].map((p) => ({ path: p, segs: segmentsOf(p) }));

  // --- 3) match + emit -------------------------------------------------------------
  const findings = [];
  const edges = [];
  // We may emit multiple route rows for the same path (one per method). For the connected edge
  // we only need the route PATH -> first reaching UI path, so dedupe edges by (route,ui).
  const edgeSeen = new Set();

  for (const r of routes) {
    const routeSegs = segmentsOf(r.route);
    // Find the first UI path that reaches this route.
    let reachedBy = null;
    for (const u of uiSegLists) {
      if (uiReachesRoute(u.segs, routeSegs)) { reachedBy = u.path; break; }
    }
    if (reachedBy === null) {
      // No UI caller -> finding. Preserve method when we have it.
      const finding = { route: r.route };
      if (r.method) finding.method = r.method;
      findings.push(finding);
    } else {
      const key = `${r.route}::${reachedBy}`;
      if (!edgeSeen.has(key)) {
        edgeSeen.add(key);
        edges.push({
          from: r.route,
          from_kind: 'route',
          to: reachedBy,
          to_kind: 'ui_surface',
          edge: 'routes_to',
          source_extractor: 'route-no-ui',
          last_seen_commit: lastSeenCommit,
        });
      }
    }
  }

  const result = {
    findings,
    edges,
    counts: {
      routes: routes.length,
      routeFilesScanned,
      uiPaths: uiPaths.size,
      findings: findings.length,
      edges: edges.length,
    },
  };
  if (degraded.length > 0) result.degraded = degraded;
  // Detector contract: report, never block. Always exit 0 (ok()).
  return ok(result);
}

try {
  main();
} catch (e) {
  // Detectors must NEVER emit a stack trace. Anything unexpected surfaces as a clean empty
  // report; still exit 0 (ok) because a detector reports, it does not block.
  ok({
    findings: [],
    edges: [],
    counts: { routes: 0, routeFilesScanned: 0, uiPaths: 0, findings: 0, edges: 0 },
    degraded: [`unexpected error: ${e && e.message ? e.message : String(e)}`],
  });
}
