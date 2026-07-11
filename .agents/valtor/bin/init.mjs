#!/usr/bin/env node
// init.mjs — Valtor Layer-A bootstrap (A7 / bootstrap gate).
//
// `node init.mjs`:
//   1. Ensure the INDEX dir exists.
//   2. For each ledger table in TABLES (except run_journal + budget, which are
//      created lazily on first append), create an empty `<table>.jsonl` if it is
//      missing. Existing files are left untouched.
//   3. Detect the three config.deployGates scripts (smokeTest, negativeAuthz,
//      ciWorkflow) on disk -> present/absent map.
//   4. Report { created:[], detected:{}, configFound:bool }.
//
// Idempotent: re-running creates nothing new (created:[] on a second run).
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TABLES, INDEX, CONFIG_PATH, existsSync, ok, fail } from './lib.mjs';

// Tables that are NOT pre-created here — they are written lazily on first append
// (run_journal is the git-ignored self-audit log; budget holds per-item counters).
const LAZY_TABLES = new Set(['run_journal', 'budget']);

// The deploy-gate config keys we probe for presence, in report order.
const DEPLOY_GATE_KEYS = ['smokeTest', 'negativeAuthz', 'ciWorkflow'];

function main() {
  const created = [];

  // 1. Ensure the index directory exists (recursive = no-op if already there).
  try {
    if (!existsSync(INDEX)) mkdirSync(INDEX, { recursive: true });
  } catch (e) {
    return fail(`could not create index dir ${INDEX}: ${e.message}`);
  }

  // 2. Create an empty <table>.jsonl per non-lazy table if missing. Never
  //    overwrite an existing ledger — re-running must not clobber another
  //    instance's data, so we use the exclusive `wx` flag.
  for (const table of TABLES) {
    if (LAZY_TABLES.has(table)) continue;
    const p = join(INDEX, `${table}.jsonl`);
    if (existsSync(p)) continue;
    try {
      writeFileSync(p, '', { flag: 'wx' }); // wx = fail if it appeared concurrently
      created.push(`${table}.jsonl`);
    } catch (e) {
      // EEXIST => another instance created it between our check and write; that
      // is fine and not a "created by us" event. Anything else is a real error.
      if (e.code !== 'EEXIST') {
        return fail(`could not create ${table}.jsonl: ${e.message}`, { created });
      }
    }
  }

  // 3. Load config defensively so we can report configFound:false instead of
  //    exiting. (lib.loadConfig() would fail()+exit on a missing/corrupt config,
  //    which would hide the report this script is contracted to print.)
  const configFound = existsSync(CONFIG_PATH);
  let config = null;
  let configWarning = null;
  if (configFound) {
    try {
      config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      configWarning = `config parse error: ${e.message}`;
    }
  }

  // 4. Detect deploy-gate scripts -> present/absent map. An absent config, an
  //    absent deployGates block, or an unset key all degrade to a clearly-marked
  //    "not configured" entry — never a throw.
  const detected = {};
  const deployGates = (config && config.deployGates) || {};
  for (const key of DEPLOY_GATE_KEYS) {
    const path = deployGates[key];
    if (typeof path !== 'string' || path.length === 0) {
      detected[key] = { configured: false, path: null, present: false };
      continue;
    }
    detected[key] = { configured: true, path, present: existsSync(path) };
  }

  const result = { created, detected, configFound };
  if (configWarning) result.configWarning = configWarning;
  return ok(result);
}

main();
