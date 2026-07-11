#!/usr/bin/env node
// deploy-health.mjs — Layer-A item A8 / gate G5.5 (Deploy-Health).
// Classify the latest (or a given) deploy of config.deployGates.ciWorkflow via the `gh` CLI.
//
//   node deploy-health.mjs [runId]
//
// READ-ONLY by contract: this script NEVER triggers, re-runs, or cancels a workflow run. It only
// observes. If `gh` is absent (or not authenticated / the query fails) it degrades to status
// 'unknown' with guidance to check manually rather than throwing.
//
// Output: { ok, status, runId, raw, ... }  (single JSON object, per the bin/ CLI contract).
// Exit codes:
//   0  green | pending | unknown | cancelled   (do not block the loop on these)
//   1  red                                       (gate-block; deploy failed)
//
// Note on `cancelled`: it is surfaced as its own status (NOT red). A cancelled run is inconclusive —
// the orchestrator should re-run, not treat it as a failed deploy.
import { execFileSync } from 'node:child_process';
import { loadConfig, args, out } from './lib.mjs';

// --- gh probe (tryGit-style: a cheap version call decides availability) ----------------------------
// NOTE: every gh invocation uses execFileSync with an ARGUMENT ARRAY (never a shell string). This
// bypasses the shell entirely, so no quoting is needed and a hostile runId / workflow value can never
// inject a second command. That matters here: this gate is read-only by contract — it must NEVER be
// able to trigger or cancel a run, and a shell-interpolated arg could do exactly that.
function ghAvailable() {
  try {
    execFileSync('gh', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

// Run a `gh` subcommand from an argv array, capturing stdout. Returns { ok, out } | { ok:false, err }.
function gh(argv) {
  try {
    const stdout = execFileSync('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { ok: true, out: stdout };
  } catch (e) {
    return { ok: false, err: String((e && e.stderr) || (e && e.message) || e).trim() };
  }
}

// Map a gh run's (status, conclusion) pair to a Valtor health status.
// conclusion is authoritative once a run has completed; status carries the in-flight cases.
function classify(run) {
  const status = String((run && run.status) || '').toLowerCase();
  const conclusion = String((run && run.conclusion) || '').toLowerCase();

  // In-flight first: a queued/in-progress run has no meaningful conclusion yet.
  if (status === 'in_progress' || status === 'queued' || status === 'requested' || status === 'waiting' || status === 'pending') {
    return 'pending';
  }

  switch (conclusion) {
    case 'success':
      return 'green';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'red';
    case 'cancelled':
      return 'cancelled';
    case '':
      // Completed-but-no-conclusion is unusual; treat as inconclusive rather than guessing red.
      return status === 'completed' ? 'unknown' : 'pending';
    default:
      // skipped / neutral / action_required / stale etc. — inconclusive, not a deploy failure.
      return 'unknown';
  }
}

// status -> process exit code. red blocks (1); everything else is non-blocking (0).
function exitFor(status) {
  return status === 'red' ? 1 : 0;
}

function emit(payload) {
  const status = payload.status;
  const code = exitFor(status);
  out({ ok: code === 0, ...payload });
  process.exit(code);
}

function main() {
  const cfg = loadConfig(); // exits with a clean JSON error if the config seam is missing/corrupt
  const workflow = cfg && cfg.deployGates && cfg.deployGates.ciWorkflow;

  const argv = args();
  const runId = argv[0] ? String(argv[0]).trim() : null;

  if (!ghAvailable()) {
    return emit({
      status: 'unknown',
      runId: runId || null,
      raw: null,
      reason: 'gh CLI not found on PATH',
      guidance: workflow
        ? `Install + authenticate the GitHub CLI (gh auth login), then check the deploy manually: gh run list --workflow ${workflow} --limit 1`
        : 'Install + authenticate the GitHub CLI (gh auth login) and configure deployGates.ciWorkflow, then check the deploy manually.',
    });
  }

  if (!workflow && !runId) {
    // Without a configured workflow and without an explicit runId we have nothing to query.
    return emit({
      status: 'unknown',
      runId: null,
      raw: null,
      reason: 'config.deployGates.ciWorkflow is not set and no runId was provided',
      guidance: 'Set deployGates.ciWorkflow in valtor.config.json, or pass an explicit runId: node deploy-health.mjs <runId>',
    });
  }

  const jsonFields = 'databaseId,status,conclusion,workflowName,headBranch,displayTitle,url,createdAt,updatedAt';
  let res;
  if (runId) {
    res = gh(['run', 'view', runId, '--json', jsonFields]);
  } else {
    res = gh(['run', 'list', '--workflow', String(workflow), '--limit', '1', '--json', jsonFields]);
  }

  if (!res.ok) {
    // gh present but the query failed (not authed, no runs, network, bad workflow name, ...).
    return emit({
      status: 'unknown',
      runId: runId || null,
      raw: null,
      reason: 'gh query failed',
      detail: res.err,
      guidance: workflow
        ? `Verify gh is authenticated (gh auth status) and the workflow exists, then: gh run list --workflow ${workflow} --limit 1`
        : 'Verify gh is authenticated (gh auth status) and the run id is correct.',
    });
  }

  let parsed;
  try {
    parsed = res.out ? JSON.parse(res.out) : null;
  } catch (e) {
    return emit({
      status: 'unknown',
      runId: runId || null,
      raw: res.out || null,
      reason: 'could not parse gh JSON output',
      detail: e.message,
      guidance: 'Re-run the gh query manually to inspect its output.',
    });
  }

  // `gh run view` returns an object; `gh run list` returns an array.
  const run = Array.isArray(parsed) ? parsed[0] : parsed;

  if (!run) {
    return emit({
      status: 'unknown',
      runId: runId || null,
      raw: parsed,
      reason: runId ? `no run found for id ${runId}` : `no runs found for workflow ${workflow}`,
      guidance: workflow
        ? `No deploy runs to classify yet. Check manually: gh run list --workflow ${workflow}`
        : 'No deploy runs to classify yet.',
    });
  }

  const status = classify(run);
  const resolvedRunId = run.databaseId != null ? String(run.databaseId) : (runId || null);

  return emit({
    status,
    runId: resolvedRunId,
    raw: run,
    workflow: workflow || null,
    ciStatus: run.status || null,
    ciConclusion: run.conclusion || null,
    ...(status === 'cancelled'
      ? { note: 're-run, not red — a cancelled run is inconclusive; trigger a fresh deploy' }
      : {}),
    ...(status === 'red'
      ? { note: 'deploy failed (blocking) — route to S-DEBUG; revert-on-branch per rollback policy' }
      : {}),
  });
}

try {
  main();
} catch (e) {
  // Last-resort guard: never leak an unhandled stack trace; emit clean JSON + nonzero.
  out({ ok: false, status: 'unknown', error: `deploy-health failed unexpectedly: ${e && e.message ? e.message : String(e)}` });
  process.exit(1);
}
