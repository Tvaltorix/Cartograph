#!/usr/bin/env node
// ledger.mjs — generic ledger CLI (Layer-A item A4/A5).
// Append/read any ledger table; everything universal lives in lib.mjs, nothing repo-specific is
// hardcoded here. See bin/README.md for the CLI contract and SCHEMA.md §3.1 for table shapes.
//
//   node ledger.mjs append <table> <jsonString>      append one stamped row
//   node ledger.mjs query  <table> [--filter k=v ...] read + equality-filter on top-level keys
//   node ledger.mjs tail   <table> <N>                last N rows
//   node ledger.mjs init                              create empty <table>.jsonl for each TABLES entry
//
// Single JSON object to stdout. Exit 0 = ok, non-zero = fail (via lib's ok()/fail()).

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  TABLES, INDEX, appendRow, readRows, ok, fail, args, existsSync,
} from './lib.mjs';

const USAGE =
  'usage: ledger.mjs <append|query|tail|init> [args] — ' +
  'append <table> <json> | query <table> [--filter k=v ...] | tail <table> <N> | init';

// Validate a table name for the read paths (appendRow validates on its own).
function assertTable(table) {
  if (!table) fail(`missing <table> argument. ${USAGE}`);
  if (!TABLES.includes(table)) {
    fail(`unknown table: ${table}`, { known: TABLES });
  }
}

// Parse repeated `--filter k=v` flags into an equality predicate map. Only the first `=` splits,
// so values may contain `=`. A flag with no `=` is a usage error rather than a silent no-op.
function parseFilters(argv) {
  const filters = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--filter') continue;
    const kv = argv[i + 1];
    if (kv === undefined) fail('--filter requires a k=v argument');
    const eq = kv.indexOf('=');
    if (eq < 1) fail(`--filter expects k=v, got: ${kv}`);
    filters[kv.slice(0, eq)] = kv.slice(eq + 1);
    i++; // consume the value token
  }
  return filters;
}

// Equality match on top-level keys. Compare as strings so a CLI "5" matches a numeric 5, and a
// "true" matches boolean true — the CLI has no type information to do otherwise.
function rowMatches(row, filters) {
  return Object.entries(filters).every(([k, v]) => {
    if (row == null || typeof row !== 'object') return false;
    if (!(k in row)) return false;
    return String(row[k]) === String(v);
  });
}

function cmdAppend(argv) {
  const [table, jsonStr] = argv;
  if (!table) fail(`append: missing <table>. ${USAGE}`);
  // appendRow itself validates the table against TABLES and fails cleanly; we only guard the JSON.
  if (jsonStr === undefined) fail('append: missing <jsonString> argument');
  let row;
  try {
    row = JSON.parse(jsonStr);
  } catch (e) {
    return fail(`append: invalid JSON: ${e.message}`);
  }
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return fail('append: row must be a JSON object');
  }
  const stamped = appendRow(table, row); // fails+exits on unknown table
  ok({ action: 'append', table, row: stamped });
}

function cmdQuery(argv) {
  const table = argv[0];
  assertTable(table);
  const filters = parseFilters(argv.slice(1));
  const rows = readRows(table); // fails+exits on a corrupt row
  const matched = Object.keys(filters).length ? rows.filter((r) => rowMatches(r, filters)) : rows;
  ok({ action: 'query', table, filter: filters, count: matched.length, rows: matched });
}

function cmdTail(argv) {
  const [table, nStr] = argv;
  assertTable(table);
  const n = Number(nStr);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    return fail(`tail: <N> must be a non-negative integer, got: ${nStr}`);
  }
  const rows = readRows(table);
  const tail = n === 0 ? [] : rows.slice(-n);
  ok({ action: 'tail', table, requested: n, count: tail.length, rows: tail });
}

// Create the index dir + an empty <table>.jsonl for any TABLES entry that's missing one. Never
// truncates an existing file (idempotent + side-effect-honest — won't clobber another instance's data).
function cmdInit() {
  try {
    if (!existsSync(INDEX)) mkdirSync(INDEX, { recursive: true });
  } catch (e) {
    return fail(`init: could not create index dir ${INDEX}: ${e.message}`);
  }
  const created = [];
  const existing = [];
  for (const table of TABLES) {
    const p = join(INDEX, `${table}.jsonl`);
    if (existsSync(p)) { existing.push(table); continue; }
    try {
      writeFileSync(p, '', { flag: 'wx' }); // wx = fail if it exists; closes a TOCTOU race
      created.push(table);
    } catch (e) {
      if (e && e.code === 'EEXIST') { existing.push(table); continue; }
      return fail(`init: could not create ${p}: ${e.message}`);
    }
  }
  ok({ action: 'init', index: INDEX, created, existing, tables: TABLES.length });
}

function main() {
  const argv = args();
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case 'append': return cmdAppend(rest);
    case 'query': return cmdQuery(rest);
    case 'tail': return cmdTail(rest);
    case 'init': return cmdInit();
    default:
      return fail(cmd ? `unknown command: ${cmd}. ${USAGE}` : USAGE);
  }
}

main();
