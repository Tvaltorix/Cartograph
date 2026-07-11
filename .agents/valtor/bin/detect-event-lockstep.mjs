#!/usr/bin/env node
// detect-event-lockstep.mjs — Layer-A orphan detector "event-no-handler" (SCHEMA §5, registry detectors).
//
// A real-time event fan-out flow has THREE surfaces that must move in lockstep
// (per the host's real-time/event docs + the emitter/router/subscriber lockstep
// discipline). An event detail-type must appear in ALL THREE or it's a silent failure:
//   1. emitter  — a service emits the detail-type to the configured event bus
//   2. fanout   — the fan-out router maps the detail-type -> (channel, target method)
//   3. ui       — the real-time client subscribes to that target method
//
// The three surfaces speak DIFFERENT vocabularies:
//   - emitter + fanout name the detail-type directly  ("Shift.Distributed")
//   - portal names the client TARGET METHOD           ("shiftDistributed")
// The fanout file is the rosetta stone: it carries `"<DetailType>" => (.., "<target>")`.
// So portal-presence of a detail-type is derived through the fanout mapping:
// a detail-type is "present in portal" iff the fanout maps it to a target the
// portal subscribes to. A detail-type the fanout never maps therefore cannot be
// shown present in portal — which is exactly the lockstep break we want to surface.
//
// Output (one JSON object, exit 0 ALWAYS — detectors report, never block):
//   {
//     ok, surfaces:{ emitter:{present,count,...glob}, fanout:{...}, portal:{...} },
//     detailTypes:[...all seen...],
//     findings:[ { detail_type, present_in:[...], missing_from:[...] } ],  // < 3 surfaces
//     edges:[ { from:<detail_type>, to:<surface>, edge:"emits|consumes" } ],
//     degraded:[ "<surface>: <reason>" ]   // absent/empty surfaces — present but partial
//   }
//
// GRACEFUL DEGRADATION is the headline requirement: a missing surface file, an
// extractor glob that matches nothing, an empty config key, or git-absent all
// produce a clean partial result + exit 0, never a stack trace. With one or more
// surfaces degraded the "present_in / missing_from" math still runs over whatever
// surfaces resolved, and the degraded surfaces are listed so the caller knows the
// finding set is partial rather than authoritative.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ok, existsSync } from './lib.mjs';

const SURFACES = ['emitter', 'fanout', 'portal'];

// ── Glob -> file list ────────────────────────────────────────────────────────
// The emitter seam is a glob; fanout/portal are single files. We resolve globs with
// a tiny dependency-free walker (node builtins only). Anything that throws (permission,
// vanished dir) degrades to "no files" rather than crashing.
function globToRegex(glob) {
  // Translate a glob to a RegExp with standard globstar semantics. lib.globToRegex's
  // naive ** -> .* wrongly REQUIRES an intermediate slash, so it drops files sitting
  // directly under the ** parent (e.g. services/guards-rs/src/cert_expiry_scan.rs under
  // services/*-rs/src/**/*.rs) — a silent emitter undercount = a false-clean lockstep
  // result. We translate locally instead:
  //   - `**/`  matches ZERO OR MORE path segments  (src/**/*.rs matches src/a.rs AND src/x/a.rs)
  //   - bare `**` (not followed by /) spans across `/`
  //   - `*`    matches within a single segment (not across `/`)
  let re = '';
  const g = String(glob);
  const META = /[.+^${}()|[\]\\?]/;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 2; } // **/  -> zero+ segments
        else { re += '.*'; i += 1; }                           // **   -> span /
      } else {
        re += '[^/]*';                                         // *    -> within a segment
      }
    } else if (META.test(c)) {
      re += '\\' + c;                                          // escape a regex metachar
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function listFiles(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // Unreadable / vanished dir -> degrade to whatever we've collected, never throw.
    return acc;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      // Prune the usual heavy/irrelevant dirs so a fresh checkout doesn't walk node_modules/target.
      if (ent.name === 'node_modules' || ent.name === 'target' || ent.name === '.git') continue;
      listFiles(full, acc);
    } else if (ent.isFile()) {
      acc.push(full.replace(/\\/g, '/'));
    }
  }
  return acc;
}

// Resolve a glob like services/*-rs/src/**/*.rs to a concrete file list.
// Strategy: walk from the longest non-glob path prefix, then filter by the full regex.
function resolveGlob(glob) {
  const norm = String(glob).replace(/\\/g, '/');
  const firstGlob = norm.search(/[*?]/);
  let root = '.';
  if (firstGlob > 0) {
    const head = norm.slice(0, firstGlob);
    const slash = head.lastIndexOf('/');
    root = slash >= 0 ? head.slice(0, slash) : '.';
  }
  if (root === '') root = '.';
  if (!existsSync(root)) return [];
  let re;
  try { re = globToRegex(norm); } catch { return []; }
  let all;
  try {
    all = listFiles(root, []);
  } catch {
    return [];
  }
  return all.filter((f) => re.test(f));
}

// Read a file's text, degrading to null (never throwing) if it's gone/unreadable.
function readSafe(path) {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// ── Detail-type + target extraction ──────────────────────────────────────────
// Detail-types are dotted PascalCase: Aggregate.Action (e.g. ShiftAssignment.Confirmed).
const DETAIL_TYPE_RE = /["']([A-Z][A-Za-z0-9]*(?:\.[A-Z][A-Za-z0-9]*)+)["']/g;
// Portal target methods: conn.on('camelCaseTarget', ...). Capture the quoted method name.
const PORTAL_TARGET_RE = /\.on\(\s*["']([A-Za-z_$][A-Za-z0-9_$]*)["']/g;
// Fanout rosetta rows: "Detail.Type" => Some(("hub", "targetMethod")) — capture detail + target.
// Tolerant of whitespace; the target is the second quoted string inside the Some((..)) tuple.
const FANOUT_MAP_RE = /["']([A-Z][A-Za-z0-9]*(?:\.[A-Z][A-Za-z0-9]*)+)["']\s*=>\s*Some\(\(\s*["'][^"']+["']\s*,\s*["']([A-Za-z_$][A-Za-z0-9_$]*)["']\s*\)\)/g;

function uniq(arr) {
  return [...new Set(arr)];
}

// Build a RegExp from a config-supplied pattern string, degrading to null (never
// throwing) if the pattern is malformed — a bad seam regex must not crash the detector.
function compilePattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) return null;
  try { return new RegExp(pattern); } catch { return null; }
}

// Pull all dotted detail-types from text.
//
// The emitter seam is glob + pattern. The pattern (put_events|detail_type|EventBridge)
// QUALIFIES a FILE as an emitter source — the same role the backendRoutes extractor's
// pattern plays — rather than gating each individual line. Real emit call sites put the
// detail-type literal several lines from the put_events/EventBridge token (it's its own
// argument line in put_event("<source>",\n  "Aggregate.Action",\n  detail)), so a
// line-window filter silently drops them. The caller decides file qualification; once a
// file qualifies we extract every dotted detail-type literal in it. A stray non-emitter
// dotted string is rare in these files and harmless — it would show emitter-present and
// surface as a lockstep finding if absent elsewhere (fail-loud, not silent).
function extractDetailTypes(text) {
  if (!text) return [];
  const found = [];
  let m;
  DETAIL_TYPE_RE.lastIndex = 0;
  while ((m = DETAIL_TYPE_RE.exec(text)) !== null) found.push(m[1]);
  return uniq(found);
}

function extractPortalTargets(text) {
  if (!text) return [];
  const found = [];
  let m;
  PORTAL_TARGET_RE.lastIndex = 0;
  while ((m = PORTAL_TARGET_RE.exec(text)) !== null) found.push(m[1]);
  return uniq(found);
}

// Fanout mapping: detail-type -> target method. This is the rosetta stone that lets us
// translate the portal's target-method vocabulary back into detail-types.
function extractFanoutMap(text) {
  const map = new Map(); // detailType -> targetMethod
  if (!text) return map;
  let m;
  FANOUT_MAP_RE.lastIndex = 0;
  while ((m = FANOUT_MAP_RE.exec(text)) !== null) map.set(m[1], m[2]);
  return map;
}

// ── Main ──────────────────────────────────────────────────────────────────
function main() {
  const config = loadConfig(); // exits non-zero only if the config seam itself is missing/corrupt
  const ev = (config && config.extractors && config.extractors.eventLockstep) || {};

  const degraded = [];

  // --- Emitter surface (glob + pattern) ---
  // glob narrows the candidate file set; pattern QUALIFIES a file as an emitter source.
  // If the pattern is absent (or won't compile) we don't gate — every globbed file is a
  // candidate — but the configured emitter pattern (e.g. put_events|detail_type|EventBridge)
  // is honored as the file-level qualifier.
  const emitterCfg = ev.emitter || {};
  const emitterGlob = typeof emitterCfg.glob === 'string' ? emitterCfg.glob : null;
  const emitterRe = compilePattern(emitterCfg.pattern);
  let emitterTypes = [];
  let emitterFileCount = 0; // total files the glob matched
  let emitterQualified = 0; // of those, how many the pattern qualified
  if (!emitterGlob) {
    degraded.push('emitter: no config.extractors.eventLockstep.emitter.glob');
  } else {
    const files = resolveGlob(emitterGlob);
    emitterFileCount = files.length;
    if (files.length === 0) {
      degraded.push(`emitter: glob matched no files (${emitterGlob})`);
    }
    if (emitterCfg.pattern && !emitterRe) {
      degraded.push(`emitter: pattern did not compile (${emitterCfg.pattern}) — treating all globbed files as emitter sources`);
    }
    const all = [];
    for (const f of files) {
      const txt = readSafe(f);
      if (txt == null) continue;
      // Qualify the file: if a usable pattern exists it must match somewhere in the
      // file; otherwise the file qualifies by glob alone.
      if (emitterRe && !emitterRe.test(txt)) continue;
      emitterQualified += 1;
      all.push(...extractDetailTypes(txt));
    }
    emitterTypes = uniq(all);
    if (files.length > 0 && emitterTypes.length === 0) {
      degraded.push('emitter: files present but no detail-types matched');
    }
  }

  // --- Fanout surface (single file) — also yields the detail-type->target map ---
  const fanoutPath = typeof ev.fanout === 'string' ? ev.fanout : null;
  let fanoutMap = new Map();
  let fanoutTypes = [];
  if (!fanoutPath) {
    degraded.push('fanout: no config.extractors.eventLockstep.fanout path');
  } else {
    const txt = readSafe(fanoutPath);
    if (txt == null) {
      degraded.push(`fanout: file absent/unreadable (${fanoutPath})`);
    } else {
      fanoutMap = extractFanoutMap(txt);
      fanoutTypes = [...fanoutMap.keys()];
      if (fanoutTypes.length === 0) {
        // Fall back to bare detail-type literals if the => Some((..)) shape didn't match
        // (e.g. a refactored router). Still degraded — we then have no target mapping.
        fanoutTypes = extractDetailTypes(txt);
        if (fanoutTypes.length === 0) {
          degraded.push('fanout: file present but no routed detail-types matched');
        } else {
          degraded.push('fanout: detail-types found but no detail->target map (cannot derive portal presence)');
        }
      }
    }
  }

  // --- Portal surface (single file) — target methods, mapped back via fanout ---
  const portalPath = typeof ev.portal === 'string' ? ev.portal : null;
  let portalTargets = [];
  if (!portalPath) {
    degraded.push('portal: no config.extractors.eventLockstep.portal path');
  } else {
    const txt = readSafe(portalPath);
    if (txt == null) {
      degraded.push(`portal: file absent/unreadable (${portalPath})`);
    } else {
      portalTargets = extractPortalTargets(txt);
      if (portalTargets.length === 0) {
        degraded.push('portal: file present but no .on() target methods matched');
      }
    }
  }

  // Invert the fanout map (target -> detailType) so portal targets translate to detail-types.
  const targetToDetail = new Map();
  for (const [dt, target] of fanoutMap.entries()) targetToDetail.set(target, dt);

  // Detail-types the portal effectively subscribes to (via the fanout mapping).
  const portalDetailTypes = uniq(
    portalTargets.map((t) => targetToDetail.get(t)).filter((dt) => typeof dt === 'string'),
  );
  // Portal targets that don't map to any known detail-type — surfaced separately so a
  // portal handler with no upstream route is visible (a UI-side orphan signal).
  const portalUnmappedTargets = portalTargets.filter((t) => !targetToDetail.has(t));

  // Presence sets per surface, keyed by detail-type.
  const presence = {
    emitter: new Set(emitterTypes),
    fanout: new Set(fanoutTypes),
    portal: new Set(portalDetailTypes),
  };

  // The universe of detail-types seen across any surface.
  const allDetailTypes = uniq([...emitterTypes, ...fanoutTypes, ...portalDetailTypes]).sort();

  // A finding = a detail-type present in FEWER than all 3 surfaces.
  const findings = [];
  for (const dt of allDetailTypes) {
    const presentIn = SURFACES.filter((s) => presence[s].has(dt));
    const missingFrom = SURFACES.filter((s) => !presence[s].has(dt));
    if (missingFrom.length > 0) {
      findings.push({ detail_type: dt, present_in: presentIn, missing_from: missingFrom });
    }
  }

  // Edges: emitter -> emits; fanout/portal -> consumes. (SCHEMA §5b edge kinds.)
  const edges = [];
  for (const dt of emitterTypes) edges.push({ from: dt, to: 'emitter', edge: 'emits' });
  for (const dt of fanoutTypes) edges.push({ from: dt, to: 'fanout', edge: 'consumes' });
  for (const dt of portalDetailTypes) edges.push({ from: dt, to: 'portal', edge: 'consumes' });

  const result = {
    surfaces: {
      emitter: { present: emitterGlob != null, count: emitterTypes.length, files: emitterFileCount, qualified: emitterQualified, glob: emitterGlob },
      fanout: { present: fanoutPath != null && presence.fanout.size > 0, count: fanoutTypes.length, path: fanoutPath, hasMap: fanoutMap.size > 0 },
      portal: { present: portalPath != null && portalTargets.length > 0, count: portalDetailTypes.length, path: portalPath, targets: portalTargets.length },
    },
    detailTypes: allDetailTypes,
    findings,
    edges,
  };
  if (portalUnmappedTargets.length > 0) result.portalUnmappedTargets = portalUnmappedTargets;
  if (degraded.length > 0) result.degraded = degraded;

  // Detectors report, never block: exit 0 always (ok()).
  ok(result);
}

main();
