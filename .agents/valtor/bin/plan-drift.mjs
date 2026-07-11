#!/usr/bin/env node
// plan-drift.mjs — Layer-A item A6 / S0 plan-drift detector.
//
// `node plan-drift.mjs <plan-path>`
//   Hash the whole plan (planHash = sha256 of file content) and hash each markdown
//   section (split on `^#{1,6} ` headings). Diff the per-section hashes against the
//   LATEST `plans` ledger row for the same plan_path:
//     - no prior row            -> status "new"
//     - prior row, hash equal   -> status "unchanged"
//     - prior row, hash differs -> status "drifted" (+ added/removed/modified headings)
//   Always append a fresh `plans` row so the fingerprint advances. Prints
//   { status, added, removed, modified } (with planHash + counts for context).
//
// Reads config only for the home/index seam via lib; never hardcodes a path.
// Exit 0 always on a successful classification (drift is information, not a gate block);
// exit 1 only on operational failure (missing arg, unreadable file, corrupt ledger).

import { readFileSync } from 'node:fs';
import {
  appendRow, readRows, sha256, nowIso, ok, fail, args, existsSync,
} from './lib.mjs';

// Split markdown into sections on ATX headings (^#{1,6} ). Everything before the
// first heading is captured under a synthetic "(preamble)" heading so no content is
// dropped from the per-section hash set. Returns [{ heading, hash }].
function sectionHashesOf(content) {
  // Normalize line endings so a CRLF/LF flip alone never reads as drift.
  const text = String(content).replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const sections = [];
  let current = { heading: '(preamble)', body: [] };
  const headingRe = /^#{1,6} /;
  for (const line of lines) {
    if (headingRe.test(line)) {
      // Flush the section that just ended (skip an empty synthetic preamble).
      if (current.heading !== '(preamble)' || current.body.some((l) => l.trim() !== '')) {
        sections.push(current);
      }
      current = { heading: line.trim(), body: [line] };
    } else {
      current.body.push(line);
    }
  }
  if (current.heading !== '(preamble)' || current.body.some((l) => l.trim() !== '')) {
    sections.push(current);
  }
  // Hash heading+body together so a body edit under an unchanged heading still drifts.
  return sections.map((s) => ({ heading: s.heading, hash: sha256(s.body.join('\n')) }));
}

// Diff two section-hash lists keyed by heading text. Duplicate headings are
// disambiguated by occurrence order (heading + "#N") so collisions degrade gracefully
// instead of silently collapsing.
function keyOf(map, heading) {
  const n = (map.get(heading) || 0) + 1;
  map.set(heading, n);
  return n === 1 ? heading : `${heading}#${n}`;
}

function indexByKey(sectionHashes) {
  const counts = new Map();
  const byKey = new Map();
  for (const s of sectionHashes || []) {
    byKey.set(keyOf(counts, s.heading), { heading: s.heading, hash: s.hash });
  }
  return byKey;
}

function diffSections(oldHashes, newHashes) {
  const oldIdx = indexByKey(oldHashes);
  const newIdx = indexByKey(newHashes);
  const added = [];
  const removed = [];
  const modified = [];
  for (const [key, val] of newIdx) {
    if (!oldIdx.has(key)) added.push(val.heading);
    else if (oldIdx.get(key).hash !== val.hash) modified.push(val.heading);
  }
  for (const [key, val] of oldIdx) {
    if (!newIdx.has(key)) removed.push(val.heading);
  }
  return { added, removed, modified };
}

function main() {
  const [planPath] = args();
  if (!planPath) {
    return fail('usage: node plan-drift.mjs <plan-path>');
  }
  if (!existsSync(planPath)) {
    return fail(`plan file not found: ${planPath}`);
  }

  let content;
  try {
    content = readFileSync(planPath, 'utf8');
  } catch (e) {
    return fail(`cannot read plan file ${planPath}: ${e.message}`);
  }

  const planHash = sha256(content.replace(/\r\n/g, '\n'));
  const sectionHashes = sectionHashesOf(content);

  // Find the latest prior `plans` row for this exact path (append-only → last wins).
  // readRows() degrades to [] when the ledger doesn't exist yet (first run = "new").
  let priorRows;
  try {
    priorRows = readRows('plans');
  } catch (e) {
    return fail(`cannot read plans ledger: ${e.message}`);
  }
  let prior = null;
  for (const row of priorRows) {
    if (row && row.plan_path === planPath) prior = row;
  }

  let status;
  let added = [];
  let removed = [];
  let modified = [];

  if (!prior) {
    status = 'new';
  } else if (prior.plan_sha256 === planHash) {
    status = 'unchanged';
  } else {
    status = 'drifted';
    const diff = diffSections(prior.section_hashes, sectionHashes);
    added = diff.added;
    removed = diff.removed;
    modified = diff.modified;
  }

  // Always advance the fingerprint with a fresh row (per SCHEMA §3.1 `plans` shape).
  try {
    appendRow('plans', {
      plan_path: planPath,
      plan_sha256: planHash,
      section_hashes: sectionHashes,
      ingested_at: nowIso(),
    });
  } catch (e) {
    return fail(`cannot append plans row: ${e.message}`);
  }

  return ok({
    status,
    added,
    removed,
    modified,
    planHash,
    sectionCount: sectionHashes.length,
  });
}

main();
