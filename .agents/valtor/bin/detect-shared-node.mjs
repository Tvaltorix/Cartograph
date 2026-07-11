#!/usr/bin/env node
// detect-shared-node.mjs — Layer-A planning detector "shared-node-collision" (registry, SCHEMA §5).
//
// Two same-wave items can have *disjoint file scope* and still collide: if their blast-radius
// (the set of graph nodes reachable within config.map.blastRadiusDepth hops) intersects on a
// SHARED node — a table / event_detail_type / service (config.map.sharedNodeKinds) — then editing
// them in parallel risks a write/contract race on that shared node. The recommendation is to
// SERIALIZE the pair even though their files don't overlap.
//
// Usage:
//   node detect-shared-node.mjs                  # items with status=in_progress are the wave
//   node detect-shared-node.mjs A,B,C            # explicit comma-separated item ids are the wave
//
// Reads:  .agents/valtor/index/graph.jsonl  (the system-map edge list; SCHEMA §5b / config.index.exports).
//         Falls back to the `edges` ledger table if graph.jsonl is absent (same row shape, SCHEMA §3.1).
// Writes: NOTHING — detectors are READ-ONLY and report; they never block and never touch the tree.
//
// Output: { ok:true, collisions:[ { a, b, shared_node } ], ... }
// Exit:   ALWAYS 0 (a detector surfaces information; the orchestrator decides). Only a malformed
//         CONFIG (loadConfig) exits non-zero — that's a broken seam, not a detector finding.
//
// GRACEFUL DEGRADATION (headline requirement): absent graph.jsonl + empty edges ledger, an empty
// items ledger, fewer than two wave items, a missing config.map key, or git-absent all produce a
// clean empty result + exit 0. A fresh repo runs this without a stack trace.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ok, args, INDEX, existsSync } from './lib.mjs';

// Tolerant jsonl table reader. Deliberately NOT lib.readRows(): readRows() calls
// fail()->process.exit(1) on the first corrupt line, which would crash this detector on a
// single bad row. A detector must report best-effort and never block, so we skip bad lines.
function readTable(table) {
  const p = join(INDEX, `${table}.jsonl`);
  if (!existsSync(p)) return [];
  try {
    return parseJsonl(readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------
// Edge loading. Source of truth per SPEC is graph.jsonl; degrade to the edges ledger.
// Both are jsonl with the SCHEMA §3.1 edge shape { from, from_kind, to, to_kind, edge, ... }.
// ---------------------------------------------------------------------------------
function loadEdges() {
  const graphPath = join(INDEX, 'graph.jsonl');
  if (existsSync(graphPath)) {
    let raw;
    try {
      raw = readFileSync(graphPath, 'utf8');
    } catch {
      // Unreadable file -> degrade to the ledger fallback rather than throw.
      return { edges: fromLedger(), source: 'edges-ledger(graph.jsonl-unreadable)' };
    }
    const edges = parseJsonl(raw);
    return { edges, source: 'graph.jsonl' };
  }
  // No graph.jsonl projection yet -> read the raw edges ledger table.
  return { edges: fromLedger(), source: 'edges-ledger' };
}

function fromLedger() {
  // Read the edges.jsonl table file DIRECTLY with the tolerant parser — NOT lib.readRows(),
  // which calls fail()->process.exit(1) on a single corrupt line. A detector must survive a
  // corrupt edge row (skip it), never crash. Absent file -> [].
  const p = join(INDEX, 'edges.jsonl');
  if (!existsSync(p)) return [];
  try {
    return parseJsonl(readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

function parseJsonl(raw) {
  const edges = [];
  for (const line of String(raw).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      if (row && typeof row === 'object') edges.push(row);
    } catch {
      // Skip a corrupt edge line — a detector reports best-effort, never crashes.
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------------
// Build a directed adjacency list keyed by node id, plus a kind lookup. A node's id is
// the `from`/`to` string; its kind is `from_kind`/`to_kind`. Edges are treated as
// UNDIRECTED for blast-radius reachability (a shared write target is reachable from
// either direction — both producers/consumers of a table or event are impacted).
// ---------------------------------------------------------------------------------
function buildGraph(edges) {
  const adj = new Map(); // nodeId -> Set(neighborId)
  const kind = new Map(); // nodeId -> kind string (last writer wins; consistent in practice)
  const link = (id, k) => {
    if (id === undefined || id === null || id === '') return;
    const s = String(id);
    if (!adj.has(s)) adj.set(s, new Set());
    if (k !== undefined && k !== null && k !== '') kind.set(s, String(k));
  };
  for (const e of edges) {
    if (!e || typeof e !== 'object') continue;
    const from = e.from;
    const to = e.to;
    link(from, e.from_kind);
    link(to, e.to_kind);
    if (from === undefined || from === null || from === '') continue;
    if (to === undefined || to === null || to === '') continue;
    const f = String(from);
    const t = String(to);
    adj.get(f).add(t);
    adj.get(t).add(f); // undirected reachability
  }
  return { adj, kind };
}

// ---------------------------------------------------------------------------------
// Seed nodes for an item: any graph node the item "is". An item record may pin to graph
// nodes via its id (a plan_item node), its `implements` list (implemented_by edges), or
// its `referent_path`. We seed with whichever of these actually EXISTS as a node in the
// graph; if none exist, the item has no footprint and simply can't collide (empty set).
// ---------------------------------------------------------------------------------
function seedNodesFor(item, adj) {
  const seeds = new Set();
  const consider = (v) => {
    if (v === undefined || v === null) return;
    const s = String(v);
    if (s && adj.has(s)) seeds.add(s);
  };
  if (item && typeof item === 'object') {
    consider(item.id);
    consider(item.referent_path);
    const imp = Array.isArray(item.implements) ? item.implements : [];
    for (const x of imp) consider(x);
    const rel = Array.isArray(item.related) ? item.related : [];
    for (const x of rel) consider(x);
  } else if (typeof item === 'string') {
    consider(item);
  }
  return seeds;
}

// BFS reachable nodes within `depth` hops from the seed set (seeds are depth 0).
function reachableWithin(seeds, adj, depth) {
  const seen = new Set(seeds);
  let frontier = [...seeds];
  for (let d = 0; d < depth; d += 1) {
    const next = [];
    for (const node of frontier) {
      const neighbors = adj.get(node);
      if (!neighbors) continue;
      for (const n of neighbors) {
        if (!seen.has(n)) {
          seen.add(n);
          next.push(n);
        }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return seen;
}

// ---------------------------------------------------------------------------------
// Resolve the wave's item ids: explicit comma-separated arg wins, else all items with
// status=in_progress. Degrades to [] when the items ledger is empty/absent.
// ---------------------------------------------------------------------------------
function resolveWaveIds(argList) {
  const csv = (argList || []).find((a) => typeof a === 'string' && a.trim() !== '');
  if (csv) {
    return [...new Set(csv.split(',').map((s) => s.trim()).filter(Boolean))];
  }
  const items = readTable('items');
  return [...new Set(
    items
      .filter((r) => r && r.status === 'in_progress' && r.id !== undefined && r.id !== null)
      .map((r) => String(r.id))
  )];
}

function main() {
  // loadConfig() exits non-zero on a missing/parse-broken config — that is a broken seam,
  // not a detector finding, so letting it fail is correct (only failure path here).
  const config = loadConfig();
  const mapCfg = (config && config.map) || {};
  const depthRaw = mapCfg.blastRadiusDepth;
  const depth = Number.isInteger(depthRaw) && depthRaw >= 0 ? depthRaw : 2; // sane default if key missing
  const sharedKinds = new Set(
    Array.isArray(mapCfg.sharedNodeKinds) && mapCfg.sharedNodeKinds.length > 0
      ? mapCfg.sharedNodeKinds.map(String)
      : ['table', 'event_detail_type', 'service']
  );

  const { edges, source } = loadEdges();
  const { adj, kind } = buildGraph(edges);

  const waveIds = resolveWaveIds(args());

  // Fewer than two items in the wave -> nothing can collide. Clean empty result.
  if (waveIds.length < 2) {
    return ok({
      collisions: [],
      wave: waveIds,
      depth,
      sharedNodeKinds: [...sharedKinds],
      edgeCount: edges.length,
      edgeSource: source,
      note: waveIds.length === 0
        ? 'no in_progress items and no explicit ids — empty wave'
        : 'single-item wave — no pair to collide',
    });
  }

  // Map item id -> its item record (for seeding). Explicit ids that aren't in the ledger
  // still seed off the id string itself (it may match a plan_item node directly).
  const itemRows = readTable('items');
  const itemById = new Map();
  for (const r of itemRows) {
    if (r && r.id !== undefined && r.id !== null) itemById.set(String(r.id), r);
  }

  // Precompute each wave item's reachable SHARED nodes (only kinds we care about).
  const sharedReach = new Map(); // itemId -> Set(sharedNodeId)
  for (const id of waveIds) {
    const item = itemById.get(id) || id; // fall back to the bare id string
    const seeds = seedNodesFor(item, adj);
    const reach = reachableWithin(seeds, adj, depth);
    const shared = new Set();
    for (const node of reach) {
      const k = kind.get(node);
      if (k && sharedKinds.has(k)) shared.add(node);
    }
    sharedReach.set(id, shared);
  }

  // Pairwise intersection on shared nodes -> a collision per shared node. Stable order:
  // (a,b) in wave order, a before b. Each distinct shared node yields its own row so the
  // orchestrator sees exactly which contract/table/service forces serialization.
  const collisions = [];
  for (let i = 0; i < waveIds.length; i += 1) {
    for (let j = i + 1; j < waveIds.length; j += 1) {
      const a = waveIds[i];
      const b = waveIds[j];
      const sa = sharedReach.get(a) || new Set();
      const sb = sharedReach.get(b) || new Set();
      if (sa.size === 0 || sb.size === 0) continue;
      // Iterate the smaller set for the intersection.
      const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
      for (const node of small) {
        if (large.has(node)) {
          collisions.push({ a, b, shared_node: node, shared_node_kind: kind.get(node) || null });
        }
      }
    }
  }

  return ok({
    collisions,
    recommendation: collisions.length > 0 ? 'serialize the colliding pairs' : 'parallel-safe',
    wave: waveIds,
    depth,
    sharedNodeKinds: [...sharedKinds],
    edgeCount: edges.length,
    edgeSource: source,
  });
}

main();
