#!/usr/bin/env node
// detect-item-no-commit.mjs — Layer-A detector "plan-item-no-commit" (SCHEMA §5, registry "plan-item-no-commit").
//
// `node detect-item-no-commit.mjs`
//   From the 'items' ledger: surface every item whose status is NOT a finished status
//   (done | deferred) AND for which NO git commit references the item id. "References" =
//   `git log --oneline --grep "<id>"` (fixed-string, all branches) returns at least one commit.
//   These are orphan candidates — tracked work with no code landing behind it.
//
//   Output: { findings: [{ id, status }], ... } and ALWAYS exit 0.
//
// Detector contract (SCHEMA §5 / README): detectors are READ-ONLY (no tree writes) and REPORT,
// never block — so they exit 0 on every path, including empty ledger, missing files, and
// git-absent. Degraded conditions (git unavailable, not a repo) are noted in the payload, not
// raised as failures: a fresh repo with no data must run this without error.

import { readRows, tryGit, ok } from './lib.mjs';

// Statuses that mean the item is finished and so is NOT expected to have pending uncommitted
// work. Everything else (open | in_progress | debugging | question | superseded | stale |
// orphan | anything unknown) is a candidate that SHOULD have a commit referencing it.
const FINISHED_STATUSES = new Set(['done', 'deferred']);

// Does any commit reference this item id? Uses --fixed-strings so an id containing regex
// metacharacters (a synthesized slug, a bracketed tag) is matched literally rather than as a
// pattern. --all scans every ref so a commit on the loop/ branch still counts. Returns:
//   { referenced: true|false }            normal answer
//   { referenced: false, degraded: <why> } git unavailable / not a repo — treat as "unknown,
//                                           surface as not-referenced but flag the degradation"
function commitReferences(id) {
  // An empty/whitespace id can't be meaningfully grepped (an empty --grep matches everything,
  // which would falsely clear the item). Treat as "no reference" without calling git.
  if (typeof id !== 'string' || id.trim() === '') return { referenced: false };

  // tryGit never throws — it returns { ok:false, err } on any non-zero/spawn failure (git
  // absent, not a repo, bad ref). git-log itself exits 0 with empty output when --grep matches
  // nothing, so ok:true + empty out is the legitimate "no commit references this id" answer.
  const res = tryGit(`log --all --oneline --fixed-strings --grep "${String(id).replace(/"/g, '\\"')}"`);
  if (!res.ok) {
    // Could be a real degradation (no git binary / not a repo) OR an empty repo with no commits
    // yet (`git log` on a repo with zero commits exits non-zero). Both mean "we cannot prove a
    // commit exists" — surface the item as not-referenced, and let the caller see the reason.
    return { referenced: false, degraded: res.err || 'git log failed' };
  }
  return { referenced: res.out.trim().length > 0 };
}

function main() {
  // readRows returns [] when the ledger file is absent or empty — the fresh-repo path. (If a row
  // is corrupt, lib.readRows fails-fast with exit 1; that is an integrity error surfaced by
  // index-rebuild, not something this detector silently swallows.)
  const items = readRows('items');

  const findings = [];
  let gitDegraded = null; // first degradation reason seen — reported once, not per item.

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const status = typeof item.status === 'string' ? item.status : null;

    // Skip finished items — they are not expected to carry pending commits.
    if (status && FINISHED_STATUSES.has(status)) continue;

    const id = item.id;
    const check = commitReferences(id);
    if (check.degraded && gitDegraded === null) gitDegraded = check.degraded;

    // No commit references it -> orphan candidate.
    if (!check.referenced) {
      findings.push({ id: id ?? null, status });
    }
  }

  const payload = { findings, scanned: items.length };
  if (gitDegraded !== null) {
    // Detector still reports + exits 0; the note tells the caller the git side was unavailable,
    // so every unfinished item shows up as a finding (we could not confirm any commit).
    payload.degraded = 'git unavailable or no commits — could not confirm commit references';
    payload.degradedDetail = gitDegraded;
  }
  return ok(payload);
}

try {
  main();
} catch (e) {
  // Detectors must never emit a stack trace. Anything unexpected surfaces as a clean report with
  // empty findings; still exit 0 (ok) because a detector reports, it does not block.
  ok({ findings: [], scanned: 0, degraded: `unexpected error: ${e && e.message ? e.message : String(e)}` });
}
