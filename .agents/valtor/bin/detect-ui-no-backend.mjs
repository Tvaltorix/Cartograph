#!/usr/bin/env node
// detect-ui-no-backend.mjs — Layer-A orphan detector (registry `ui-no-backend`, SCHEMA §5).
//
// The INVERSE of detect-route-no-ui: find UI fetch/endpoint path strings that match NO
// backend route. A UI call to a path no service serves is a dead affordance (404 in the
// field) — the orphan class SCHEMA §5 names "UI-no-backend".
//
//   UI call sites      = config.extractors.uiCallSites  (a single `file`, or a `glob`)
//   Backend routes      = config.extractors.backendRoutes (a `glob` of route files + a `pattern`)
//   finding             = a UI path with no backend route whose template it matches
//
// Output: { ok, findings:[{ ui_call }], edges:[], ... }. Edges are [] by design — an orphan
// UI call has NO backend endpoint to point at, so there is no real (from -> to) edge to emit
// (the registry marks this detector emitsEdges:true for symmetry with route-no-ui, but the
// SPEC for THIS direction is an empty edge list; the matched pairs surface as `matched` context).
//
// CONTRACT (SCHEMA §4, registry detectors): READ-ONLY (never writes the tree or the ledger),
// reports but never blocks — exit 0 ALWAYS on a clean run (even with zero findings, zero files,
// empty config, or git absent). Exit 1 is reserved for an operational failure that makes the
// result meaningless (config missing/unparseable — surfaced by lib.loadConfig()).
//
// GRACEFUL DEGRADATION is the headline requirement: an extractor glob that matches nothing,
// an absent file, or a missing config key produces a clean empty/partial result + exit 0,
// never a stack trace. A fresh repo with no portal and no services runs this without error.

import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { loadConfig, matchesAny, ok, existsSync, args } from './lib.mjs';

// ---------------------------------------------------------------------------------------------
// File discovery. The config may name either a single `file` or a `glob`. We resolve both into
// a concrete file list, walking the tree ourselves (zero deps, cross-platform) and matching
// against the glob via lib.matchesAny. Anything unreadable/absent degrades to "skip this file".
// ---------------------------------------------------------------------------------------------

// Walk the repo from cwd collecting candidate files, pruning heavy/irrelevant dirs so a real
// repo doesn't time out. Returns forward-slash-normalized relative paths.
function walkRepo(maxFiles) {
  const PRUNE = new Set([
    '.git', 'node_modules', 'target', 'dist', 'build', '.next', 'out',
    '.agents', 'coverage', '.turbo', '.cache', 'vendor', '__pycache__',
  ]);
  const found = [];
  const stack = ['.'];
  while (stack.length > 0) {
    if (found.length >= maxFiles) break;
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir -> skip, never throw
    }
    for (const ent of entries) {
      const name = ent.name;
      const full = dir === '.' ? name : `${dir}${sep}${name}`;
      let isDir = false;
      let isFile = false;
      try {
        // Dirent flags are reliable on most platforms; fall back to stat on symlinks/unknowns.
        if (ent.isDirectory()) isDir = true;
        else if (ent.isFile()) isFile = true;
        else {
          const st = statSync(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        }
      } catch {
        continue;
      }
      if (isDir) {
        if (!PRUNE.has(name)) stack.push(full);
      } else if (isFile) {
        found.push(full.split(sep).join('/'));
        if (found.length >= maxFiles) break;
      }
    }
  }
  return found;
}

// Resolve a config extractor spec (which may carry `file` and/or `glob`) into a concrete,
// existing, deduped file list. Missing keys / absent files degrade to fewer (or zero) files.
function resolveFiles(spec, maxFiles) {
  if (!spec || typeof spec !== 'object') return { files: [], note: 'extractor spec absent' };
  const out = new Set();
  const notes = [];

  // Explicit single file (an instance may point uiCallSites at one file).
  const fileKeys = []
    .concat(typeof spec.file === 'string' ? [spec.file] : [])
    .concat(Array.isArray(spec.files) ? spec.files.filter((f) => typeof f === 'string') : []);
  for (const f of fileKeys) {
    const norm = f.replace(/\\/g, '/');
    if (existsSync(norm)) out.add(norm);
    else notes.push(`file not found: ${norm}`);
  }

  // Glob — walk + match. Only walk if a glob is actually present (avoid the cost otherwise).
  if (typeof spec.glob === 'string' && spec.glob.length > 0) {
    let all;
    try {
      all = walkRepo(maxFiles);
    } catch {
      all = [];
    }
    const patterns = globVariants(spec.glob);
    let matched = 0;
    for (const p of all) {
      if (matchesAny(p, patterns)) {
        out.add(p);
        matched += 1;
      }
    }
    if (matched === 0) notes.push(`glob matched no files: ${spec.glob}`);
  }

  return { files: [...out], note: notes.join('; ') };
}

// lib.globToRegex turns `**/` into `.*/`, which forces at least one slash — so `a/**/x.rs`
// fails to match `a/x.rs` (the "** spans ZERO segments" case). We can't edit shared lib, so
// here we expand a glob into equivalent variants that cover the zero-segment reading:
// for every `**/` we also emit a form with that `**/` removed. The union is matched with OR,
// so a path matching ANY variant counts. Bounded (cap the expansion) to stay cheap + safe.
function globVariants(glob) {
  const variants = new Set([glob]);
  const MAX = 16;
  // Iteratively remove one `**/` occurrence at a time from each known variant.
  let frontier = [glob];
  while (frontier.length > 0 && variants.size < MAX) {
    const next = [];
    for (const g of frontier) {
      let idx = g.indexOf('**/');
      while (idx !== -1) {
        const collapsed = g.slice(0, idx) + g.slice(idx + 3); // drop the `**/`
        if (!variants.has(collapsed)) {
          variants.add(collapsed);
          next.push(collapsed);
          if (variants.size >= MAX) break;
        }
        idx = g.indexOf('**/', idx + 1);
      }
      if (variants.size >= MAX) break;
    }
    frontier = next;
  }
  return [...variants];
}

function readFileSafe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null; // unreadable -> treat as empty, never throw
  }
}

// ---------------------------------------------------------------------------------------------
// Path normalization. Both sides express the same endpoint with different param syntax:
//   backend route literal : "/guards/:id/certifications"   (axum `:param`)
//   backend route literal : "/sites/{id}"                  ({param} style, if present)
//   UI call literal        : "/guards/abc123/certifications" (concrete id) OR "/guards/${x}" (template)
// We normalize every segment that is a parameter (a `:name` / `{name}` placeholder, a JS
// template hole `${...}`/`{x}`, or a concrete id-looking token) to a single wildcard `*`,
// then compare templates. This makes "/guards/abc123" match the route "/guards/:id".
// ---------------------------------------------------------------------------------------------

// Does a path segment look like a concrete identifier (so the UI baked a value into the URL)?
// UUIDs, long hex/alnum ids, all-digit ids, and template holes all collapse to a wildcard.
function isParamSegment(seg) {
  if (seg === '') return false;
  if (seg.startsWith(':')) return true; // axum :param
  if (seg.startsWith('{') && seg.endsWith('}')) return true; // {param}
  if (seg.includes('${') || seg.includes('}')) return true; // JS template hole `${id}`
  // UUID
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true;
  // Pure numeric id
  if (/^\d+$/.test(seg)) return true;
  // Opaque alphanumeric id: letters+digits, NO hyphen/underscore word structure, contains a
  // digit (so static multi-word route words like `audit-logs`, `open-shifts`, `time-entries`,
  // `oauth2`-style words stay literal). `abc123` collapses; `audit-logs` does not. Min length 4
  // avoids collapsing short literal words; `oauth2` is excluded because it has no separator yet
  // ends in a digit — handled by requiring >=2 digits OR length >=8 to be id-like.
  if (/^[A-Za-z0-9]+$/.test(seg) && !/^[A-Za-z]+$/.test(seg)) {
    const digits = (seg.match(/\d/g) || []).length;
    if (seg.length >= 4 && (digits >= 2 || seg.length >= 8)) return true;
  }
  return false;
}

// Config-driven scope tokens for the api-prefix strip below. Set from
// config.extractors.uiCallSites.apiScopePrefixes in main(). EMPTY by default — a fresh
// repo with no `/api/<scope>/` namespacing convention gets NO stripping, so the two sides
// compare on the raw path. Repos that DO namespace UI calls under `/api/<scope>/` (the
// backend registers routes without that prefix) list their scope tokens here so the
// detector can line the two namespaces up. The `{...}` template-hole form is auto-derived
// from each token, and a param-ish 2nd segment is always treated as a hole.
let API_SCOPE_PREFIXES = new Set();

// Reduce a raw path string to a comparable template: strip query/hash, optionally drop a
// leading `/api/<scope>` prefix (when the repo configures scope tokens), lowercase, collapse
// each param-ish segment to `*`. Returns null for a string that isn't a usable endpoint path.
function templatize(rawPath) {
  if (typeof rawPath !== 'string') return null;
  let p = rawPath.trim();
  if (p === '') return null;
  // Drop protocol+host if a full URL slipped in (we only compare the path portion).
  p = p.replace(/^[a-z]+:\/\/[^/]+/i, '');
  // Strip query string and fragment.
  p = p.split('?')[0].split('#')[0];
  if (!p.startsWith('/')) return null; // not a path literal
  // Normalize duplicate slashes; drop trailing slash (but keep root "/").
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');

  let segs = p.split('/').slice(1); // drop the leading ""

  // Some UI clients prefix calls with `/api/<scope>/` (e.g. a tenant/audience namespace)
  // while the backend registers routes WITHOUT that prefix. When the repo configures its
  // scope tokens, strip a leading `api/<scope>` so the two sides compare on the same
  // namespace. Only strip when the 2nd seg is a configured scope token or a template hole
  // (so a legit "/api/health" route isn't mangled). With no configured tokens, nothing is
  // stripped.
  if (
    API_SCOPE_PREFIXES.size > 0 &&
    segs.length >= 2 &&
    segs[0].toLowerCase() === 'api' &&
    (isParamSegment(segs[1]) || API_SCOPE_PREFIXES.has(segs[1].toLowerCase()))
  ) {
    segs = segs.slice(2);
  }

  if (segs.length === 0) return '/';
  const norm = segs.map((s) => (isParamSegment(s) ? '*' : s.toLowerCase()));
  return '/' + norm.join('/');
}

// Build the scope-token set from a config-supplied list. Each token also implies its
// `{token}` template-hole form (the `{tenantScope}`-style literal a UI client may emit).
function buildScopePrefixes(list) {
  const set = new Set();
  if (!Array.isArray(list)) return set;
  for (const t of list) {
    if (typeof t !== 'string' || t.length === 0) continue;
    const lo = t.toLowerCase();
    set.add(lo);
    set.add(`{${lo}}`);
  }
  return set;
}

// ---------------------------------------------------------------------------------------------
// Extraction. UI call sites: pull every path-like string literal (single/double/back-tick) that
// begins with `/`. Backend routes: pull the first string-literal argument of each route macro
// matched by the configured pattern. Both are deliberately permissive — a false-positive
// orphan SURFACES for human review (G6 never auto-acts), a missed extraction just under-reports.
// ---------------------------------------------------------------------------------------------

// Path-ish string literals: `/...`, "/...", '/...'. We capture the inside of the quotes.
const PATH_LITERAL_RE = /(['"`])(\/[A-Za-z0-9_\-/:{}$.~]*)\1/g;

function extractUiCalls(files) {
  const calls = new Map(); // template -> { template, raw:Set, files:Set }
  for (const f of files) {
    const content = readFileSafe(f);
    if (content === null) continue;
    let m;
    PATH_LITERAL_RE.lastIndex = 0;
    while ((m = PATH_LITERAL_RE.exec(content)) !== null) {
      const raw = m[2];
      const tmpl = templatize(raw);
      if (!tmpl) continue;
      if (!calls.has(tmpl)) calls.set(tmpl, { template: tmpl, raw: new Set(), files: new Set() });
      const rec = calls.get(tmpl);
      rec.raw.add(raw);
      rec.files.add(f);
    }
  }
  return calls;
}

function extractBackendRoutes(files, pattern) {
  // The pattern (e.g. `\.route\(|\.nest\(|Router::new`) tells us a route-registration site.
  // For each line/region that matches it, grab the first quoted string literal that looks like
  // a path. We scan line-by-line: a `.route("/x", ...)` puts the literal on (or near) the line.
  let lineRe = null;
  try {
    if (typeof pattern === 'string' && pattern.length > 0) lineRe = new RegExp(pattern);
  } catch {
    lineRe = null; // bad regex in config -> fall back to "any line with a quoted path"
  }
  const STR_RE = /(['"`])(\/[A-Za-z0-9_\-/:{}$.~]*)\1/g;
  const routes = new Map(); // template -> { template, raw:Set, files:Set }

  for (const f of files) {
    const content = readFileSafe(f);
    if (content === null) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isRouteLine = lineRe ? lineRe.test(line) : true;
      if (!isRouteLine) continue;
      // The path literal may sit on this line OR the next couple (multi-line `.route(\n "..."`).
      const window = [line, lines[i + 1] || '', lines[i + 2] || ''].join('\n');
      STR_RE.lastIndex = 0;
      let m;
      while ((m = STR_RE.exec(window)) !== null) {
        const raw = m[2];
        const tmpl = templatize(raw);
        if (!tmpl) continue;
        if (!routes.has(tmpl)) routes.set(tmpl, { template: tmpl, raw: new Set(), files: new Set() });
        const rec = routes.get(tmpl);
        rec.raw.add(raw);
        rec.files.add(f);
      }
    }
  }
  return routes;
}

// ---------------------------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------------------------
function main() {
  // --jsonl/positional ignored; this detector takes no required args. Tolerate a --debug flag.
  const debug = args().includes('--debug');

  const config = loadConfig(); // exits non-zero only on missing/unparseable config (operational)
  const extractors = (config && config.extractors) || {};
  const MAX_FILES = 50000;

  const uiSpec = extractors.uiCallSites;
  const beSpec = extractors.backendRoutes;

  // Repo-specific api-prefix-strip tokens (config-driven; empty => no stripping).
  API_SCOPE_PREFIXES = buildScopePrefixes(uiSpec && uiSpec.apiScopePrefixes);

  const uiResolved = resolveFiles(uiSpec, MAX_FILES);
  const beResolved = resolveFiles(beSpec, MAX_FILES);

  const uiCalls = extractUiCalls(uiResolved.files);
  const bePattern = beSpec && typeof beSpec === 'object' ? beSpec.pattern : undefined;
  const beRoutes = extractBackendRoutes(beResolved.files, bePattern);

  // A UI call is an orphan if NO backend route template matches it. Matching is two-way:
  //   - the UI template equals a route template, OR
  //   - one is a wildcard-generalization of the other (segment-wise, `*` matches anything).
  const beTemplates = [...beRoutes.keys()];

  function segMatch(a, b) {
    const A = a.split('/');
    const B = b.split('/');
    if (A.length !== B.length) return false;
    for (let i = 0; i < A.length; i++) {
      if (A[i] === B[i]) continue;
      if (A[i] === '*' || B[i] === '*') continue; // wildcard segment matches anything
      return false;
    }
    return true;
  }

  function hasBackend(uiTmpl) {
    return beTemplates.some((rt) => segMatch(uiTmpl, rt));
  }

  const findings = [];
  const matched = []; // context: UI calls that DID resolve to a backend route
  for (const [tmpl, rec] of uiCalls) {
    if (hasBackend(tmpl)) {
      matched.push({ ui_call: tmpl });
      continue;
    }
    // Surface the most informative raw form (a concrete sample) plus the normalized template.
    const raws = [...rec.raw];
    findings.push({
      ui_call: raws[0] || tmpl,
      template: tmpl,
      raw_samples: raws.slice(0, 5),
      seen_in: [...rec.files].slice(0, 5),
    });
  }

  // Stable ordering for deterministic output / diffs.
  findings.sort((a, b) => String(a.ui_call).localeCompare(String(b.ui_call)));
  matched.sort((a, b) => String(a.ui_call).localeCompare(String(b.ui_call)));

  const result = {
    detector: 'ui-no-backend',
    class: 'orphan',
    findings, // [{ ui_call, ... }]
    edges: [], // by spec: an orphan UI call has no backend endpoint to edge to
    summary: {
      ui_calls: uiCalls.size,
      backend_routes: beRoutes.size,
      orphans: findings.length,
      matched: matched.length,
    },
    seams: {
      ui_files: uiResolved.files.length,
      backend_files: beResolved.files.length,
      ui_note: uiResolved.note || undefined,
      backend_note: beResolved.note || undefined,
    },
  };

  if (debug) {
    result.matched = matched;
    result.backend_templates = beTemplates.sort();
  }

  // Detectors REPORT, never block: exit 0 always on a clean run (ok() exits 0).
  ok(result);
}

main();
