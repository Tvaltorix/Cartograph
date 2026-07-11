#!/usr/bin/env node
// render-system-map.mjs — projection 'system-map' (registry.json; SCHEMA §5 + §5b).
//
//   node render-system-map.mjs
//
// Writes TWO artifacts, ONE extraction pass:
//   1. HOME/system-map.md            — a human-readable Mermaid graph (8 node kinds, 9 edge kinds)
//   2. HOME/index/graph.jsonl        — one edge per line, the orchestrator greps it for blast-radius (S4)
// (HOME honors $VALTOR_HOME, so a dry-run in an isolated temp home never pollutes the real repo.)
//
// THE UNIFYING REFRAME (SCHEMA §5): the system map is the UNION of the detector extractor edge
// lists — NOT a second extraction. So this renderer drives the four *emitsEdges* detectors
// (route-no-ui, ui-no-backend, event-lockstep, migration-no-model) and unions their edge output,
// then adds depends_on / implements edges from the 'items' ledger. We re-derive route-no-ui
// inline (no `.mjs` ships for it) from the SAME extractors the ui-no-backend detector uses, and
// spawn the other three detectors as child processes (they each print one JSON object to stdout),
// so the map and the sweep never run divergent extraction passes (that would be a drift source on
// the most-trusted surface).
//
// RENDERER CONTRACT (SCHEMA §4 projections, README): a renderer WRITES ONLY its single declared
// artifact(s) — here system-map.md + graph.jsonl — and never edits the rest of the tree. It
// REPORTS, never blocks: it ALWAYS exits 0 (even on an empty ledger / empty repo / git absent).
// The one JSON object on stdout carries the paths + node/edge counts + degraded-seam notes so the
// orchestrator can confirm the regen without re-reading the files.
//
// GRACEFUL DEGRADATION is the headline requirement: a detector that fails to spawn, an extractor
// glob that matches nothing, an absent seam file, an empty 'items' ledger, a missing config key,
// or git-absent each degrade to "omit that edge kind with a one-line note" and still produce a
// VALID (possibly empty) graph + exit 0 — never a stack trace. Degraded mode follows
// config.map.requireSeams / optionalSeams: minimum viable map = routes + UI + migrations.

import {
  HOME, INDEX, tablePath, loadConfig, tryGit, nowIso, ok, out, matchesAny, existsSync,
} from './lib.mjs';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// SCHEMA §5b node + edge vocabularies. We never emit a kind outside these sets.
const NODE_KINDS = new Set([
  'service', 'route', 'ui_surface', 'event_detail_type', 'migration', 'table', 'adr', 'plan_item',
]);
const EDGE_KINDS = new Set([
  'calls', 'routes_to', 'emits', 'consumes', 'persists_to',
  'depends_on', 'supersedes', 'governed_by', 'implemented_by',
]);

// The directory THIS script lives in — sibling detector scripts resolve against it (robust to cwd).
const BIN_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------------------------
// Defensive jsonl reader (mirrors render-board.mjs): survey every line, skip+count corrupt rows,
// never throw, never mutate the file. We deliberately do NOT use lib.readRows() (it fails-fast on
// the first corrupt row) — a renderer must degrade, not abort.
// ---------------------------------------------------------------------------------------------
function surveyTable(table) {
  let p;
  try { p = tablePath(table); } catch { return { rows: [], corrupt: 0, missing: true }; }
  if (!existsSync(p)) return { rows: [], corrupt: 0, missing: true };
  let raw;
  try { raw = readFileSync(p, 'utf8'); }
  catch { return { rows: [], corrupt: 0, missing: true }; }
  const rows = [];
  let corrupt = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try { rows.push(JSON.parse(line)); } catch { corrupt += 1; }
  }
  return { rows, corrupt, missing: false };
}

// ---------------------------------------------------------------------------------------------
// Tiny dependency-free filesystem glob walker (same shape the detectors use). Cross-platform:
// returns repo-relative forward-slash paths; degrades to [] on any walk error.
// ---------------------------------------------------------------------------------------------
function toPosix(p) { return String(p).split(sep).join('/').replace(/\\/g, '/'); }

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
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      const name = ent.name;
      const full = dir === '.' ? name : `${dir}${sep}${name}`;
      let isDir = false, isFile = false;
      try {
        if (ent.isDirectory()) isDir = true;
        else if (ent.isFile()) isFile = true;
        else { const st = statSync(full); isDir = st.isDirectory(); isFile = st.isFile(); }
      } catch { continue; }
      if (isDir) { if (!PRUNE.has(name)) stack.push(full); }
      else if (isFile) {
        found.push(toPosix(full));
        if (found.length >= maxFiles) break;
      }
    }
  }
  return found;
}

// lib.globToRegex turns `**/` into `.*/`, which forces at least one slash — so `a/**/x.rs`
// fails to match the flat `a/x.rs` (the "** spans ZERO segments" reading). We cannot edit the
// shared lib, so we expand a glob into equivalent variants that ALSO cover the zero-segment case:
// for every `**/` we additionally emit the form with that `**/` removed, and match the union with
// OR. This is the SAME workaround the detect-* extractors carry, so the route/UI resolution here
// lines up EXACTLY with the canonical detectors (no divergent extraction — SCHEMA §5). Bounded to
// stay cheap + safe.
function globVariants(glob) {
  const variants = new Set([glob]);
  const MAX = 16;
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

// Resolve an extractor spec (a `file` and/or a `glob`) into a concrete, existing, deduped list.
function resolveFiles(spec, maxFiles) {
  if (!spec || typeof spec !== 'object') return { files: [], note: 'extractor spec absent' };
  const set = new Set();
  const notes = [];
  const fileKeys = []
    .concat(typeof spec.file === 'string' ? [spec.file] : [])
    .concat(Array.isArray(spec.files) ? spec.files.filter((f) => typeof f === 'string') : []);
  for (const f of fileKeys) {
    const norm = toPosix(f);
    if (existsSync(norm)) set.add(norm);
    else notes.push(`file not found: ${norm}`);
  }
  if (typeof spec.glob === 'string' && spec.glob.length > 0) {
    let all = [];
    try { all = walkRepo(maxFiles); } catch { all = []; }
    const patterns = globVariants(spec.glob); // cover the flat-file `**/` zero-segment case
    let matched = 0;
    for (const p of all) { if (matchesAny(p, patterns)) { set.add(p); matched += 1; } }
    if (matched === 0) notes.push(`glob matched no files: ${spec.glob}`);
  }
  return { files: [...set], note: notes.join('; ') };
}

function readFileSafe(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// Path templatization — IDENTICAL semantics to detect-ui-no-backend.mjs so the route-no-ui
// re-derivation here lines up exactly with the ui-no-backend detector's matching (no divergent
// extraction). Collapses param-ish segments to `*`, strips the UI client's /api/<scope> prefix.
// ---------------------------------------------------------------------------------------------
function isParamSegment(seg) {
  if (seg === '') return false;
  if (seg.startsWith(':')) return true;
  if (seg.startsWith('{') && seg.endsWith('}')) return true;
  if (seg.includes('${') || seg.includes('}')) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true;
  if (/^\d+$/.test(seg)) return true;
  if (/^[A-Za-z0-9_-]{12,}$/.test(seg) && /\d/.test(seg)) return true;
  return false;
}
// Config-driven api-prefix-strip tokens (set from config.extractors.uiCallSites
// .apiScopePrefixes in main()). EMPTY by default — no `/api/<scope>/` namespacing is
// assumed for a fresh repo, so nothing is stripped. Mirrors detect-ui-no-backend.mjs.
let API_SCOPE_PREFIXES = new Set();
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
function templatize(rawPath) {
  if (typeof rawPath !== 'string') return null;
  let p = rawPath.trim();
  if (p === '') return null;
  p = p.replace(/^[a-z]+:\/\/[^/]+/i, '');
  p = p.split('?')[0].split('#')[0];
  if (!p.startsWith('/')) return null;
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  let segs = p.split('/').slice(1);
  // Strip a leading `api/<scope>` only when the repo configured its scope tokens.
  if (
    API_SCOPE_PREFIXES.size > 0
    && segs.length >= 2 && segs[0].toLowerCase() === 'api'
    && (isParamSegment(segs[1]) || API_SCOPE_PREFIXES.has(segs[1].toLowerCase()))
  ) { segs = segs.slice(2); }
  if (segs.length === 0) return '/';
  return '/' + segs.map((s) => (isParamSegment(s) ? '*' : s.toLowerCase())).join('/');
}
function segMatch(a, b) {
  const A = String(a).split('/'); const B = String(b).split('/');
  if (A.length !== B.length) return false;
  for (let i = 0; i < A.length; i++) {
    if (A[i] === B[i]) continue;
    if (A[i] === '*' || B[i] === '*') continue;
    return false;
  }
  return true;
}

// Path-ish string literals: `/...`, "/...", '/...'.
const PATH_LITERAL_RE = /(['"`])(\/[A-Za-z0-9_\-/:{}$.~]*)\1/g;

// Derive the owning *service* node for a backend route file path (services/<name>-rs/...).
function serviceOfFile(file) {
  const m = toPosix(file).match(/services\/([A-Za-z0-9_-]+)\//);
  return m ? m[1] : null;
}

function extractUiCallTemplates(files) {
  const set = new Set();
  for (const f of files) {
    const content = readFileSafe(f);
    if (content === null) continue;
    PATH_LITERAL_RE.lastIndex = 0;
    let m;
    while ((m = PATH_LITERAL_RE.exec(content)) !== null) {
      const tmpl = templatize(m[2]);
      if (tmpl) set.add(tmpl);
    }
  }
  return set;
}

// Backend routes -> Map(template -> { service:Set, files:Set }). Mirrors the detector's
// line-window scan so the route templates line up with the ui-no-backend side.
function extractBackendRoutes(files, pattern) {
  let lineRe = null;
  try { if (typeof pattern === 'string' && pattern.length > 0) lineRe = new RegExp(pattern); }
  catch { lineRe = null; }
  const STR_RE = /(['"`])(\/[A-Za-z0-9_\-/:{}$.~]*)\1/g;
  const routes = new Map();
  for (const f of files) {
    const content = readFileSafe(f);
    if (content === null) continue;
    const svc = serviceOfFile(f);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lineRe ? !lineRe.test(lines[i]) : false) continue;
      const window = [lines[i], lines[i + 1] || '', lines[i + 2] || ''].join('\n');
      STR_RE.lastIndex = 0;
      let m;
      while ((m = STR_RE.exec(window)) !== null) {
        const tmpl = templatize(m[2]);
        if (!tmpl) continue;
        if (!routes.has(tmpl)) routes.set(tmpl, { service: new Set(), files: new Set() });
        const rec = routes.get(tmpl);
        if (svc) rec.service.add(svc);
        rec.files.add(f);
      }
    }
  }
  return routes;
}

// ---------------------------------------------------------------------------------------------
// Graph accumulator. Nodes are keyed `kind::id`; edges are deduped on (from,fromKind,edge,to,toKind).
// `addEdge` silently drops any edge whose kind isn't in the SCHEMA vocabulary — the map never
// invents a kind. `note` accumulates one-line degraded-seam messages (SCHEMA §5b degraded mode).
// ---------------------------------------------------------------------------------------------
function makeGraph() {
  const nodes = new Map();  // key -> { id, kind }
  const edges = [];         // { from, from_kind, to, to_kind, edge, source_extractor }
  const edgeSeen = new Set();
  const notes = [];

  function nodeKey(kind, id) { return `${kind}::${id}`; }
  function addNode(kind, id) {
    if (id == null || id === '') return;
    if (!NODE_KINDS.has(kind)) return; // never emit a node kind outside the vocabulary
    const key = nodeKey(kind, id);
    if (!nodes.has(key)) nodes.set(key, { id: String(id), kind });
  }
  function addEdge(from, fromKind, to, toKind, edge, source) {
    if (!EDGE_KINDS.has(edge)) return;     // SCHEMA §5b: 9 edge kinds only
    if (!NODE_KINDS.has(fromKind) || !NODE_KINDS.has(toKind)) return;
    if (from == null || from === '' || to == null || to === '') return;
    addNode(fromKind, from);
    addNode(toKind, to);
    const k = `${fromKind}::${from}|${edge}|${toKind}::${to}`;
    if (edgeSeen.has(k)) return;
    edgeSeen.add(k);
    edges.push({ from: String(from), from_kind: fromKind, to: String(to), to_kind: toKind, edge, source_extractor: source });
  }
  function note(s) { if (s) notes.push(String(s)); }
  // `notes` is exposed on the returned object so the renderer can read accumulated degraded-seam
  // messages after extraction (graphNotes() reads graph.notes).
  return { nodes, edges, addNode, addEdge, note, notes };
}

// ---------------------------------------------------------------------------------------------
// Spawn a sibling detector script and parse its single JSON object from stdout. Returns
// { ok, json } | { ok:false, err }. NEVER throws — a detector that crashes/spawn-fails degrades
// the corresponding edge kind to "omitted" with a note, it never aborts the renderer.
// ---------------------------------------------------------------------------------------------
function runDetector(scriptName) {
  const scriptPath = join(BIN_DIR, scriptName);
  if (!existsSync(scriptPath)) return { ok: false, err: `script absent: ${scriptName}` };
  let res;
  try {
    res = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      // Inherit env (so VALTOR_HOME flows into the child) but never inherit stdin.
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120000,
    });
  } catch (e) {
    return { ok: false, err: `spawn error: ${e && e.message ? e.message : String(e)}` };
  }
  if (res.error) return { ok: false, err: `spawn error: ${res.error.message}` };
  const stdout = res.stdout || '';
  // The detector prints exactly one pretty-printed JSON object. Parse the whole stdout; if that
  // fails (extra log noise), fall back to the last balanced {...} block.
  let json = null;
  try { json = JSON.parse(stdout); }
  catch {
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { json = JSON.parse(stdout.slice(start, end + 1)); } catch { json = null; }
    }
  }
  if (json == null) return { ok: false, err: `unparseable detector output (${scriptName})` };
  return { ok: true, json };
}

// ---------------------------------------------------------------------------------------------
// Seam policy. config.map.requireSeams must all be present (a required seam that degrades is a
// HARD note + the map still renders what it can); optionalSeams degrade quietly. Minimum viable
// map per SCHEMA §5b = routes + UI + migrations; eventLockstep + gatewayRouteMap are optional.
// We surface, per seam, whether it contributed any edges.
// ---------------------------------------------------------------------------------------------
function seamPolicy(config) {
  const map = (config && config.map) || {};
  const require = Array.isArray(map.requireSeams) ? map.requireSeams : [];
  const optional = Array.isArray(map.optionalSeams) ? map.optionalSeams : [];
  return { require, optional };
}

// ---------------------------------------------------------------------------------------------
// Mermaid emission. Group nodes by kind into subgraphs; render edges with a labeled arrow.
// IDs are sanitized to Mermaid-safe node ids (alnum+underscore), with the original label kept
// in the bracket text. Empty graph -> a valid Mermaid block with a single placeholder note node.
// ---------------------------------------------------------------------------------------------
const KIND_LABEL = {
  service: 'Service', route: 'Route', ui_surface: 'UI Surface',
  event_detail_type: 'Event', migration: 'Migration', table: 'Table',
  adr: 'ADR', plan_item: 'Plan Item',
};
const KIND_SHAPE = {
  // [text] rectangle, ([text]) stadium, [(text)] cylinder, {{text}} hexagon, >text] flag
  service: (t) => `[["${t}"]]`,
  route: (t) => `("${t}")`,
  ui_surface: (t) => `>"${t}"]`,
  event_detail_type: (t) => `{{"${t}"}}`,
  migration: (t) => `[/"${t}"/]`,
  table: (t) => `[("${t}")]`,
  adr: (t) => `["${t}"]`,
  plan_item: (t) => `("${t}")`,
};

function mermaidId(kind, id) {
  return (`${kind}_${id}`).replace(/[^A-Za-z0-9_]/g, '_');
}
function mermaidEscape(s) {
  // Mermaid label text inside quotes — escape embedded quotes + collapse newlines.
  return String(s == null ? '' : s).replace(/"/g, '#quot;').replace(/\r?\n/g, ' ').trim();
}

function renderMermaid(graph) {
  const lines = [];
  lines.push('```mermaid');
  lines.push('graph LR');
  if (graph.nodes.size === 0) {
    lines.push('  empty["(empty graph — no extractor seams resolved)"]');
    lines.push('```');
    return lines.join('\n');
  }
  // Subgraph per node kind, in a stable order.
  const order = ['service', 'route', 'ui_surface', 'event_detail_type', 'migration', 'table', 'adr', 'plan_item'];
  const byKind = new Map();
  for (const { id, kind } of graph.nodes.values()) {
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(id);
  }
  for (const kind of order) {
    const ids = byKind.get(kind);
    if (!ids || ids.length === 0) continue;
    ids.sort();
    lines.push(`  subgraph ${kind}["${KIND_LABEL[kind] || kind}"]`);
    for (const id of ids) {
      const mid = mermaidId(kind, id);
      const shape = (KIND_SHAPE[kind] || ((t) => `["${t}"]`))(mermaidEscape(id));
      lines.push(`    ${mid}${shape}`);
    }
    lines.push('  end');
  }
  // Edges (sorted for deterministic diffs).
  const sortedEdges = [...graph.edges].sort((a, b) => {
    const ka = `${a.from_kind}:${a.from}:${a.edge}:${a.to_kind}:${a.to}`;
    const kb = `${b.from_kind}:${b.from}:${b.edge}:${b.to_kind}:${b.to}`;
    return ka.localeCompare(kb);
  });
  for (const e of sortedEdges) {
    const f = mermaidId(e.from_kind, e.from);
    const t = mermaidId(e.to_kind, e.to);
    lines.push(`  ${f} -->|${e.edge}| ${t}`);
  }
  lines.push('```');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Write a file, creating its parent dir. Never throws out of here — a write failure is reported
// in the result payload (renderer reports, never blocks).
// ---------------------------------------------------------------------------------------------
function writeArtifact(path, content) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e && e.message ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
function main() {
  const config = loadConfig(); // exits non-zero only on missing/corrupt config (operational)
  const extractors = (config && config.extractors) || {};
  const MAX_FILES = 50000;
  const policy = seamPolicy(config);
  const graph = makeGraph();

  // Per-seam contribution tally (for the result payload + the markdown's degraded section).
  const seams = {
    backendRoutes: { resolved: false, edges: 0 },
    uiCallSites: { resolved: false, edges: 0 },
    migrations: { resolved: false, edges: 0 },
    eventLockstep: { resolved: false, edges: 0 },
    gatewayRouteMap: { resolved: false, edges: 0 },
    items: { resolved: false, edges: 0 },
  };

  // ---- Seam 1+2: routes + UI (re-derived inline; route-no-ui has no .mjs) ------------------
  // We compute BOTH directions from the same extraction (route-no-ui ∪ ui-no-backend) so the map
  // gets routes_to (UI surface -> route) + calls (route -> service) edges. A matched UI call →
  // route is a `routes_to` edge; every route → its owning service is a `calls`/ownership edge.
  const beSpec = extractors.backendRoutes;
  const uiSpec = extractors.uiCallSites;
  // Repo-specific api-prefix-strip tokens (config-driven; empty => no stripping).
  API_SCOPE_PREFIXES = buildScopePrefixes(uiSpec && uiSpec.apiScopePrefixes);
  const beResolved = resolveFiles(beSpec, MAX_FILES);
  const uiResolved = resolveFiles(uiSpec, MAX_FILES);
  const bePattern = beSpec && typeof beSpec === 'object' ? beSpec.pattern : undefined;
  const beRoutes = extractBackendRoutes(beResolved.files, bePattern);
  const uiTemplates = extractUiCallTemplates(uiResolved.files);

  if (beResolved.files.length === 0) {
    graph.note(`backendRoutes seam: ${beResolved.note || 'no route files resolved'} — route/service edges omitted`);
  } else {
    seams.backendRoutes.resolved = true;
    // route -> service ownership (calls), and ensure each route is a node.
    for (const [tmpl, rec] of beRoutes) {
      graph.addNode('route', tmpl);
      const services = [...rec.service];
      if (services.length === 0) {
        // Route with no resolvable service still appears as a node (orphan-ish); no calls edge.
        continue;
      }
      for (const svc of services) {
        // addEdge(from, fromKind, to, toKind, edge, source): route IS-served-BY service (calls).
        graph.addEdge(tmpl, 'route', svc, 'service', 'calls', 'route-no-ui');
        seams.backendRoutes.edges += 1;
      }
    }
  }

  if (uiResolved.files.length === 0) {
    graph.note(`uiCallSites seam: ${uiResolved.note || 'no UI file resolved'} — UI routes_to edges omitted`);
  } else {
    seams.uiCallSites.resolved = true;
    // The portal client file is the single UI surface node we anchor calls to.
    const uiSurface = (uiSpec && typeof uiSpec === 'object' && typeof uiSpec.file === 'string')
      ? uiSpec.file : 'portal-ui';
    graph.addNode('ui_surface', uiSurface);
    const beTemplates = [...beRoutes.keys()];
    for (const uiTmpl of uiTemplates) {
      // A UI call that resolves to a backend route -> routes_to edge (UI surface -> route).
      // addEdge(from, fromKind, to, toKind, edge, source).
      const match = beTemplates.find((rt) => segMatch(uiTmpl, rt));
      if (match) {
        graph.addEdge(uiSurface, 'ui_surface', match, 'route', 'routes_to', 'ui-no-backend');
        seams.uiCallSites.edges += 1;
      } else {
        // UI-no-backend orphan: the call points at a route node that doesn't exist. We still
        // record the intended route as a node so the orphan is visible on the map, and draw the
        // routes_to edge to it (the missing endpoint surfaces as a route node with no `calls`
        // edge to any service). This is the SCHEMA §5 "UI-no-backend" orphan made visible.
        graph.addNode('route', uiTmpl);
        graph.addEdge(uiSurface, 'ui_surface', uiTmpl, 'route', 'routes_to', 'ui-no-backend');
        seams.uiCallSites.edges += 1;
      }
    }
  }

  // ---- Seam 3: migrations (persists_to: migration -> table) --------------------------------
  // Spawn the existing detector; union its `edges:[{from,to,edge:'persists_to'}]` output.
  const migSpec = extractors.migrations;
  if (!migSpec || typeof migSpec.glob !== 'string') {
    graph.note('migrations seam: config.extractors.migrations.glob not set — persists_to edges omitted');
  } else {
    const det = runDetector('detect-migration-no-model.mjs');
    if (!det.ok) {
      graph.note(`migrations seam: detector unavailable (${det.err}) — persists_to edges omitted`);
    } else {
      const j = det.json;
      const detEdges = Array.isArray(j.edges) ? j.edges : [];
      if ((j.degraded && detEdges.length === 0) || detEdges.length === 0) {
        graph.note(`migrations seam: ${j.reason || 'no migration edges'} — persists_to edges omitted`);
      } else {
        seams.migrations.resolved = true;
      }
      for (const e of detEdges) {
        if (!e || e.from == null || e.to == null) continue;
        graph.addEdge(String(e.from), 'migration', String(e.to), 'table', 'persists_to', 'migration-no-model');
        seams.migrations.edges += 1;
      }
    }
  }

  // ---- Seam 4 (optional): event lockstep (emits / consumes) --------------------------------
  // Spawn detect-event-lockstep.mjs; its edges are {from:<detailType>, to:<surface>, edge:'emits'|'consumes'}.
  // Map surface -> node kind: emitter => the detail-type IS emitted (event node) by a service-ish
  // surface; we model both emits + consumes as edges between the event_detail_type node and a
  // synthetic surface service node so the lockstep is visible on the graph.
  const evCfg = extractors.eventLockstep;
  if (!evCfg) {
    graph.note('eventLockstep seam (optional): not configured — emits/consumes edges omitted');
  } else {
    const det = runDetector('detect-event-lockstep.mjs');
    if (!det.ok) {
      graph.note(`eventLockstep seam (optional): detector unavailable (${det.err}) — emits/consumes edges omitted`);
    } else {
      const j = det.json;
      const detEdges = Array.isArray(j.edges) ? j.edges : [];
      if (detEdges.length === 0) {
        graph.note('eventLockstep seam (optional): no event edges resolved — emits/consumes omitted');
      } else {
        seams.eventLockstep.resolved = true;
      }
      // surface name -> a stable, repo-neutral service node label. (The concrete files
      // these surfaces map to are config-driven via extractors.eventLockstep.*.)
      const SURFACE_NODE = { emitter: 'event-emitter', fanout: 'event-fanout', portal: 'ui-subscriber' };
      for (const e of detEdges) {
        if (!e || e.from == null || e.to == null) continue;
        const evt = String(e.from);            // detail-type, e.g. "Shift.Distributed"
        const surface = String(e.to);          // 'emitter' | 'fanout' | 'portal'
        const svcNode = SURFACE_NODE[surface] || surface;
        if (e.edge === 'emits') {
          // service emits event: service -> event
          graph.addEdge(svcNode, 'service', evt, 'event_detail_type', 'emits', 'event-lockstep');
        } else {
          // consumes: service consumes event: service -> event
          graph.addEdge(svcNode, 'service', evt, 'event_detail_type', 'consumes', 'event-lockstep');
        }
        seams.eventLockstep.edges += 1;
      }
    }
  }

  // ---- Seam 5 (optional): gateway route map (routes_to at the API-GW tier) -----------------
  // The gatewayRouteMap extractor names a CDK file + a vpcProxyIntegration|:80\d\d pattern. We do
  // a light derivation: each service port mapping is a routes_to edge from an "api-gateway" service
  // node to the backend service. Absence degrades quietly (it's optional per config.map).
  const gwSpec = extractors.gatewayRouteMap;
  if (!gwSpec || typeof gwSpec.file !== 'string') {
    graph.note('gatewayRouteMap seam (optional): not configured — gateway edges omitted');
  } else if (!existsSync(toPosix(gwSpec.file))) {
    graph.note(`gatewayRouteMap seam (optional): file absent (${gwSpec.file}) — gateway edges omitted`);
  } else {
    const txt = readFileSafe(toPosix(gwSpec.file));
    if (txt == null) {
      graph.note(`gatewayRouteMap seam (optional): file unreadable (${gwSpec.file}) — gateway edges omitted`);
    } else {
      // Only emit edges from a clean, unambiguous signal: `vpcProxyIntegration('<service>', ...)`
      // where the FIRST argument is a quoted service token. We deliberately do NOT mine bare
      // `:80\d\d` ports — in this codebase those live mostly in COMMENTS (a parity changelog with
      // dates), so a port heuristic produces garbage targets (dates, "ANY"). A regex can't tell a
      // commented port from a live one without a TS parser, so the honest behavior for this
      // OPTIONAL seam is to degrade cleanly rather than pollute the graph. (When the integration
      // call DOES carry a quoted service name, we use it.) Tokens are filtered to look like a
      // service id (contains a letter, length 2-60) so a stray literal can't slip through.
      const targets = new Set();
      const intRe = /vpcProxyIntegration\s*\(\s*['"`]([A-Za-z][A-Za-z0-9_-]{1,59})['"`]/g;
      let m;
      while ((m = intRe.exec(txt)) !== null) targets.add(m[1]);
      if (targets.size === 0) {
        graph.note('gatewayRouteMap seam (optional): no quoted vpcProxyIntegration service targets matched (port literals are comment-only here) — gateway edges omitted');
      } else {
        seams.gatewayRouteMap.resolved = true;
        graph.addNode('service', 'api-gateway');
        for (const t of targets) {
          graph.addEdge('api-gateway', 'service', t, 'service', 'routes_to', 'gateway-route-map');
          seams.gatewayRouteMap.edges += 1;
        }
      }
    }
  }

  // ---- Items ledger: depends_on + implements (+ governed_by, supersedes when present) -------
  // depends_on: plan_item -> plan_item.  implements: plan_item -> referent (route/ui/migration/...).
  // governed_by: plan_item -> adr (provenance, when config.map.provenanceEdges).  supersedes too.
  const itemsSurvey = surveyTable('items');
  if (itemsSurvey.missing) {
    graph.note('items ledger: absent — depends_on/implements edges omitted (fresh repo)');
  } else if (itemsSurvey.rows.length === 0) {
    graph.note('items ledger: empty — depends_on/implements edges omitted');
  }
  if (itemsSurvey.corrupt > 0) graph.note(`items ledger: ${itemsSurvey.corrupt} corrupt row(s) skipped`);

  const provenanceOn = !(config && config.map && config.map.provenanceEdges === false);
  // Map a referent_kind to a node kind for `implements` edges.
  const REFERENT_KIND_TO_NODE = {
    route: 'route', ui: 'ui_surface', event: 'event_detail_type',
    migration: 'migration', doc: 'adr', adr: 'adr', memory: 'adr',
    table: 'table', service: 'service',
  };
  // Known item ids (so a depends_on to an untracked id still draws, as a plan_item node).
  for (const it of itemsSurvey.rows) {
    if (!it || typeof it !== 'object' || it.id == null) continue;
    graph.addNode('plan_item', it.id);
  }
  for (const it of itemsSurvey.rows) {
    if (!it || typeof it !== 'object' || it.id == null) continue;
    seams.items.resolved = true;
    const id = String(it.id);

    // depends_on -> plan_item
    if (Array.isArray(it.depends_on)) {
      for (const dep of it.depends_on) {
        if (dep == null || dep === '') continue;
        graph.addEdge(id, 'plan_item', String(dep), 'plan_item', 'depends_on', 'items-ledger');
        seams.items.edges += 1;
      }
    }

    // implements -> the referent it implements (graph: plan_item implemented_by? — SCHEMA names
    // the edge `implemented_by`; the natural reading is referent IS implemented_by plan_item, so
    // we draw referent --implemented_by--> plan_item). The `implements` array on the item carries
    // referent ids; pair with referent_kind/referent_path when present for the node kind.
    const refKind = REFERENT_KIND_TO_NODE[String(it.referent_kind || '').toLowerCase()] || 'route';
    const implTargets = Array.isArray(it.implements) ? it.implements : [];
    for (const tgt of implTargets) {
      if (tgt == null || tgt === '') continue;
      graph.addEdge(String(tgt), refKind, id, 'plan_item', 'implemented_by', 'items-ledger');
      seams.items.edges += 1;
    }
    // If the item declares a single referent_path with no `implements[]`, still tie the item to it.
    if (implTargets.length === 0 && it.referent_path) {
      graph.addEdge(String(it.referent_path), refKind, id, 'plan_item', 'implemented_by', 'items-ledger');
      seams.items.edges += 1;
    }

    // governed_by (provenance): plan_item -> adr, derived from a `source` like "ADR-0026" or an
    // explicit `governed_by`/`adr` field. Only when provenance edges are enabled (config.map).
    if (provenanceOn) {
      const adrIds = new Set();
      const srcStr = `${it.source || ''} ${it.text || ''} ${it.goal || ''}`;
      const adrRe = /\bADR-\d{3,4}\b/g;
      let am;
      while ((am = adrRe.exec(srcStr)) !== null) adrIds.add(am[0]);
      if (Array.isArray(it.governed_by)) for (const g of it.governed_by) if (g) adrIds.add(String(g));
      for (const adr of adrIds) {
        graph.addEdge(id, 'plan_item', adr, 'adr', 'governed_by', 'items-ledger');
        seams.items.edges += 1;
      }
    }

    // supersedes: plan_item -> plan_item (when the item records what it replaces).
    const supersedes = Array.isArray(it.supersedes) ? it.supersedes
      : (it.status === 'superseded' && it.superseded_by ? [it.superseded_by] : []);
    for (const sup of supersedes) {
      if (sup == null || sup === '') continue;
      graph.addEdge(id, 'plan_item', String(sup), 'plan_item', 'supersedes', 'items-ledger');
      seams.items.edges += 1;
    }
  }

  // ---- Required-seam policy check (SCHEMA §5b degraded mode) --------------------------------
  // A required seam that contributed zero edges is a HARD note (the map still renders). The
  // minimum-viable map is routes + UI + migrations — we report whether that floor was met.
  const hardNotes = [];
  for (const req of policy.require) {
    const s = seams[req];
    if (!s || !s.resolved) hardNotes.push(`REQUIRED seam '${req}' did not resolve — map is below the configured floor`);
  }
  const minViableMet = seams.backendRoutes.resolved || seams.uiCallSites.resolved || seams.migrations.resolved;

  // ---- Resolve the current commit (best-effort) for edge provenance -------------------------
  const headRes = tryGit('rev-parse --short HEAD');
  const headSha = headRes.ok ? headRes.out.trim() : null;

  // ---- Write graph.jsonl (one edge per line) ------------------------------------------------
  const graphJsonlPath = join(INDEX, 'graph.jsonl');
  const jsonlLines = [...graph.edges]
    .sort((a, b) => {
      const ka = `${a.from_kind}:${a.from}:${a.edge}:${a.to_kind}:${a.to}`;
      const kb = `${b.from_kind}:${b.from}:${b.edge}:${b.to_kind}:${b.to}`;
      return ka.localeCompare(kb);
    })
    .map((e) => JSON.stringify({
      from: e.from, from_kind: e.from_kind, to: e.to, to_kind: e.to_kind,
      edge: e.edge, source_extractor: e.source_extractor, last_seen_commit: headSha,
    }));
  // Always end with a trailing newline so appends stay line-aligned; empty graph -> empty file.
  const jsonlContent = jsonlLines.length ? jsonlLines.join('\n') + '\n' : '';
  const jsonlWrite = writeArtifact(graphJsonlPath, jsonlContent);

  // ---- Write system-map.md (Mermaid + legend + degraded section) ----------------------------
  const mapPath = join(HOME, 'system-map.md');
  const nodeCountByKind = {};
  for (const { kind } of graph.nodes.values()) nodeCountByKind[kind] = (nodeCountByKind[kind] || 0) + 1;
  const edgeCountByKind = {};
  for (const e of graph.edges) edgeCountByKind[e.edge] = (edgeCountByKind[e.edge] || 0) + 1;

  const md = [];
  md.push('# System Map');
  md.push('');
  md.push('> Generated by `render-system-map.mjs` (projection `system-map`, SCHEMA §5b). The graph is the');
  md.push('> **union of the detector extractor edge lists** (route-no-ui ∪ ui-no-backend ∪ event-lockstep ∪');
  md.push('> migration-no-model) **plus** `depends_on` / `implements` / `governed_by` / `supersedes` from the');
  md.push('> `items` ledger — one extraction pass, two artifacts (`system-map.md` + `index/graph.jsonl`).');
  md.push('');
  md.push(`- Generated: ${nowIso()}`);
  md.push(`- Commit: ${headSha || '(git unavailable)'}`);
  md.push(`- Nodes: ${graph.nodes.size}  ·  Edges: ${graph.edges.length}`);
  md.push(`- Minimum-viable map (routes + UI + migrations) met: ${minViableMet ? 'yes' : 'no'}`);
  md.push('');
  md.push('## Graph');
  md.push('');
  md.push(renderMermaid(graph));
  md.push('');

  md.push('## Counts');
  md.push('');
  md.push('| Node kind | Count |');
  md.push('|---|---|');
  for (const k of ['service', 'route', 'ui_surface', 'event_detail_type', 'migration', 'table', 'adr', 'plan_item']) {
    md.push(`| ${k} | ${nodeCountByKind[k] || 0} |`);
  }
  md.push('');
  md.push('| Edge kind | Count |');
  md.push('|---|---|');
  for (const k of ['calls', 'routes_to', 'emits', 'consumes', 'persists_to', 'depends_on', 'supersedes', 'governed_by', 'implemented_by']) {
    md.push(`| ${k} | ${edgeCountByKind[k] || 0} |`);
  }
  md.push('');

  md.push('## Seam coverage');
  md.push('');
  md.push('| Seam | Kind | Resolved | Edges |');
  md.push('|---|---|---|---|');
  const seamKind = {
    backendRoutes: 'required-floor', uiCallSites: 'required-floor', migrations: 'required-floor',
    eventLockstep: 'optional', gatewayRouteMap: 'optional', items: 'ledger',
  };
  for (const [name, s] of Object.entries(seams)) {
    md.push(`| ${name} | ${seamKind[name] || ''} | ${s.resolved ? 'yes' : 'no'} | ${s.edges} |`);
  }
  md.push('');

  if (hardNotes.length || graphNotes(graph).length || graph.nodes.size === 0) {
    md.push('## Degraded / notes');
    md.push('');
    if (graph.nodes.size === 0) {
      md.push('- Empty graph — no extractor seam resolved any edge (fresh repo / no data). This is a');
      md.push('  valid empty map, not an error.');
    }
    for (const n of hardNotes) md.push(`- **${n}**`);
    // graph.note pushed into the closure's `notes` array — expose it via a getter.
    for (const n of graphNotes(graph)) md.push(`- ${n}`);
    md.push('');
  }

  md.push('## Legend');
  md.push('');
  md.push('- **8 node kinds:** service · route · ui_surface · event_detail_type · migration · table · adr · plan_item');
  md.push('- **9 edge kinds:** calls · routes_to · emits · consumes · persists_to · depends_on · supersedes · governed_by · implemented_by');
  md.push('');

  const mdWrite = writeArtifact(mapPath, md.join('\n') + '\n');

  // ---- Result (one JSON object; renderer reports, never blocks -> exit 0 via ok()) ----------
  ok({
    projection: 'system-map',
    artifacts: {
      systemMap: { path: mapPath, written: mdWrite.ok, err: mdWrite.err },
      graphJsonl: { path: graphJsonlPath, written: jsonlWrite.ok, err: jsonlWrite.err },
    },
    nodes: graph.nodes.size,
    edges: graph.edges.length,
    nodeCountByKind,
    edgeCountByKind,
    seams,
    minViableMet,
    requiredSeamGaps: hardNotes,
    notes: graphNotes(graph),
  });
}

// Read the graph's accumulated degraded-seam notes (makeGraph exposes them on `graph.notes`).
function graphNotes(graph) {
  return Array.isArray(graph && graph.notes) ? graph.notes : [];
}

// --- Wrap main so a renderer NEVER emits a stack trace (it reports + exits 0). ---
try {
  main();
} catch (e) {
  out({
    ok: true,
    projection: 'system-map',
    degraded: true,
    error: `unexpected error (reported, not thrown): ${e && e.message ? e.message : String(e)}`,
    nodes: 0,
    edges: 0,
  });
  process.exit(0);
}
