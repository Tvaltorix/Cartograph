#!/usr/bin/env node
// lock.mjs — Layer-A item A1: the cross-session lock (SCHEMA §2 ACQUIRE-LOCK, §6 HALT case 7).
// One Valtor instance works the repo at a time. The lockfile at config.lock.path is a single JSON
// object (NOT jsonl — it's a live singleton, not an append-only ledger). Subcommands:
//   acquire   — take the lock if free or stale; live non-stale lock → exit 1 {liveLock,holder} (HALT 7)
//   heartbeat — refresh heartbeat_at only; must be owned by self (VALTOR_INSTANCE)
//   release   — delete the lockfile if owned by self (or --force)
//   status    — report holder + stale:bool + ageMs (read-only)
// Everything repo-specific (path, staleAfter window, the field set) is read from config — never hardcoded.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { loadConfig, parseDuration, uuid, nowIso, ok, fail, args, existsSync, rmSync } from './lib.mjs';

// --- flag parsing: --state <S> --plan <P> --force ---------------------------------------------
function parseFlags(argv) {
  const flags = { state: null, plan: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--state') flags.state = argv[++i] ?? null;
    else if (a === '--plan') flags.plan = argv[++i] ?? null;
    else if (a === '--force') flags.force = true;
  }
  return flags;
}

// --- safe lockfile read: missing → null; corrupt → fail loud (don't silently clobber) ----------
function readLock(path) {
  if (!existsSync(path)) return null;
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) { return fail(`cannot read lockfile at ${path}: ${e.message}`, { lockPath: path }); }
  if (!raw.trim()) return null; // empty file behaves like no lock
  try { return JSON.parse(raw); }
  catch (e) { return fail(`corrupt lockfile at ${path}: ${e.message}`, { lockPath: path }); }
}

// Ensure the lockfile's parent dir exists so a cold acquire (before init.mjs) doesn't ENOENT.
function ensureDir(path) {
  const d = dirname(path);
  if (d && !existsSync(d)) {
    try { mkdirSync(d, { recursive: true }); }
    catch (e) { return fail(`cannot create lockfile dir ${d}: ${e.message}`, { lockPath: path }); }
  }
}

// Plain overwrite — ONLY safe once ownership is proven (heartbeat by self). Never used to take a
// lock we don't already hold; acquire uses createLockExclusive instead.
function writeLock(path, lock) {
  ensureDir(path);
  try { writeFileSync(path, JSON.stringify(lock, null, 2) + '\n'); }
  catch (e) { return fail(`cannot write lockfile at ${path}: ${e.message}`, { lockPath: path }); }
}

// Atomic create-exclusive (O_EXCL): write the lock ONLY if the file does not already exist. Returns
// true on success; false if we lost a create race (EEXIST). This is the safety spine — two concurrent
// acquires cannot both succeed, so the lock can never be double-held (fail-CLOSED, not fail-OPEN).
function createLockExclusive(path, lock) {
  ensureDir(path);
  try { writeFileSync(path, JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' }); return true; }
  catch (e) {
    if (e && e.code === 'EEXIST') return false; // lost the race — caller re-evaluates / HALTs
    return fail(`cannot write lockfile at ${path}: ${e.message}`, { lockPath: path });
  }
}

// Build a fresh lock object honoring config.lock.fields. We populate the canonical fields and only
// emit those the config declares, so the on-disk shape tracks the config seam.
function buildLock(fields, { state, plan }) {
  const canonical = {
    // Adopt the caller's stable identity (VALTOR_INSTANCE) so the owner can heartbeat/release its own lock;
    // fall back to a random uuid when unset (then release requires --force). Must match selfInstance().
    instance_id: process.env.VALTOR_INSTANCE || uuid(),
    host: hostname(),
    pid: process.pid,
    started_at: nowIso(),
    current_state: state || null,
    plan_path: plan || null,
    heartbeat_at: nowIso(),
  };
  // If config declares an explicit field set, project onto it (preserving any unknown extras as null);
  // otherwise emit the full canonical shape.
  if (Array.isArray(fields) && fields.length) {
    const out = {};
    for (const f of fields) out[f] = (f in canonical) ? canonical[f] : null;
    return out;
  }
  return canonical;
}

function ageMs(lock) {
  const hb = lock && lock.heartbeat_at ? Date.parse(lock.heartbeat_at) : NaN;
  if (Number.isNaN(hb)) return null; // unknown/unparseable heartbeat
  return Date.now() - hb;
}

function isStale(lock, staleMs) {
  const age = ageMs(lock);
  if (age === null) return true;        // no/garbled heartbeat → treat as stale (recoverable)
  if (!staleMs || staleMs <= 0) return false; // no window configured → never auto-stale
  return age > staleMs;
}

// self identity: the instance that owns *this* process tree, identified via VALTOR_INSTANCE env.
function selfInstance() { return process.env.VALTOR_INSTANCE || null; }

function main() {
  const argv = args();
  const sub = argv[0];
  const flags = parseFlags(argv.slice(1));

  const VALID = ['acquire', 'heartbeat', 'release', 'status'];
  if (!sub || !VALID.includes(sub)) {
    return fail(`usage: lock.mjs <${VALID.join('|')}> [--state S --plan P] [--force]`, { subcommand: sub || null });
  }

  const config = loadConfig(); // fails loudly if config missing/unparseable
  const lockCfg = (config && config.lock) || {};
  const lockPath = lockCfg.path;
  if (!lockPath) return fail('config.lock.path is not set — cannot locate the lockfile', { configKey: 'lock.path' });

  const staleMs = parseDuration(lockCfg.staleAfter || ''); // 0 if unset/unparseable → "never auto-stale"
  const fields = lockCfg.fields;
  const existing = readLock(lockPath); // may be null

  // ----- status: read-only report ------------------------------------------------------------
  if (sub === 'status') {
    if (!existing) return ok({ subcommand: 'status', held: false, holder: null, stale: null, ageMs: null, lockPath });
    return ok({
      subcommand: 'status', held: true, holder: existing,
      stale: isStale(existing, staleMs), ageMs: ageMs(existing),
      staleAfterMs: staleMs || null, lockPath,
    });
  }

  // ----- acquire ------------------------------------------------------------------------------
  // Safety spine: the lock can never be double-held. The read above is advisory only; the WRITE is
  // atomic (O_EXCL create), so a concurrent acquirer between our read and our write loses the create
  // race and we fail-CLOSED to HALT — never silently clobber another instance's freshly-taken lock.
  if (sub === 'acquire') {
    if (existing) {
      const stale = isStale(existing, staleMs);
      if (!stale) {
        // HALT case 7 — a live, non-stale lock is held by another instance.
        return fail('lock is held by a live instance (HALT case 7)', {
          subcommand: 'acquire', liveLock: true, holder: existing,
          ageMs: ageMs(existing), staleAfterMs: staleMs || null, lockPath,
        });
      }
      // Stale lock → safe to take over. Do it atomically: remove the stale file, then create-exclusive.
      // If another instance grabbed it in the gap (create race lost), re-read and HALT — never clobber.
      try { rmSync(lockPath, { force: true }); }
      catch (e) { return fail(`cannot clear stale lockfile at ${lockPath}: ${e.message}`, { lockPath }); }
      const fresh = buildLock(fields, flags);
      if (!createLockExclusive(lockPath, fresh)) {
        const now = readLock(lockPath);
        return fail('lost takeover race — another instance acquired during stale takeover (HALT case 7)', {
          subcommand: 'acquire', liveLock: true, holder: now, lockPath,
        });
      }
      return ok({
        subcommand: 'acquire', acquired: true, takeover: true,
        displaced: existing, displacedAgeMs: ageMs(existing), staleAfterMs: staleMs || null,
        holder: fresh, instance_id: fresh.instance_id, lockPath,
      });
    }
    // Free (per our read) → claim it atomically. If we lose the create race, re-read and HALT.
    const fresh = buildLock(fields, flags);
    if (!createLockExclusive(lockPath, fresh)) {
      const now = readLock(lockPath);
      return fail('lost acquire race — another instance took the lock first (HALT case 7)', {
        subcommand: 'acquire', liveLock: true, holder: now, lockPath,
      });
    }
    return ok({
      subcommand: 'acquire', acquired: true, takeover: false,
      holder: fresh, instance_id: fresh.instance_id, lockPath,
    });
  }

  // ----- heartbeat: refresh heartbeat_at only; must be owned by self --------------------------
  if (sub === 'heartbeat') {
    if (!existing) return fail('no lock to heartbeat — acquire first', { subcommand: 'heartbeat', held: false, lockPath });
    const self = selfInstance();
    if (!self) {
      return fail('VALTOR_INSTANCE env not set — cannot prove ownership for heartbeat', {
        subcommand: 'heartbeat', holder: existing, lockPath,
      });
    }
    if (existing.instance_id !== self) {
      return fail('lock is held by a different instance — refusing to heartbeat (would steal another instance\'s lock)', {
        subcommand: 'heartbeat', self, holder: existing, lockPath,
      });
    }
    // Re-read immediately before the write to shrink the TOCTOU window: if our lock went stale and a
    // different instance took it over between our first read and now, the on-disk instance_id no longer
    // matches us — refuse, so a slow heartbeat can never clobber (steal back) the new owner's lock.
    const current = readLock(lockPath);
    if (!current) {
      return fail('lock disappeared before heartbeat — refusing (re-acquire if you still need it)', {
        subcommand: 'heartbeat', self, lockPath,
      });
    }
    if (current.instance_id !== self) {
      return fail('lock was taken over by a different instance — refusing to heartbeat', {
        subcommand: 'heartbeat', self, holder: current, lockPath,
      });
    }
    const updated = { ...current, heartbeat_at: nowIso() };
    // Optionally refresh state/plan if provided alongside the heartbeat (keeps the lock honest about progress).
    if (flags.state !== null && ('current_state' in updated)) updated.current_state = flags.state;
    if (flags.plan !== null && ('plan_path' in updated)) updated.plan_path = flags.plan;
    writeLock(lockPath, updated);
    return ok({ subcommand: 'heartbeat', heartbeat: true, holder: updated, lockPath });
  }

  // ----- release: delete the lockfile if owned by self (or --force) ---------------------------
  if (sub === 'release') {
    if (!existing) return ok({ subcommand: 'release', released: false, reason: 'no-lock-present', lockPath });
    const self = selfInstance();
    // Re-read just before deciding so a stale-takeover that happened after our first read can't be
    // clobbered by a self-release of the lock we no longer actually own.
    const current = readLock(lockPath);
    if (!current) return ok({ subcommand: 'release', released: false, reason: 'no-lock-present', lockPath });
    const ownedBySelf = self && current.instance_id === self;
    if (!ownedBySelf && !flags.force) {
      return fail('lock is owned by a different instance — pass --force to release anyway', {
        subcommand: 'release', self: self || null, holder: current, lockPath,
      });
    }
    try { rmSync(lockPath, { force: true }); }
    catch (e) { return fail(`cannot delete lockfile at ${lockPath}: ${e.message}`, { lockPath }); }
    return ok({ subcommand: 'release', released: true, forced: !ownedBySelf, wasHeldBy: current, lockPath });
  }

  // unreachable (VALID guard above), but keep the contract honest
  return fail(`unhandled subcommand: ${sub}`);
}

main();
