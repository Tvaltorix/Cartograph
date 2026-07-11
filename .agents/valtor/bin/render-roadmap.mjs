#!/usr/bin/env node
// render-roadmap.mjs — projection 'roadmap' (registry.json) → HOME/roadmap.md.
//
//   node render-roadmap.mjs
//
// Writes the GENERATED status board: a simple, regenerable projection of the `items` ledger,
// grouped by (plan_id, phase), showing per item its status, id, goal, and last_seen_commit.
// Empty ledger → a valid roadmap.md whose body is "no items tracked yet." (per spec).
//
// This is DISTINCT from the hand-authored .agents/valtor/ROADMAP.md (the build plan / gap
// register). The generated board lives at the lower-case path the registry names for this
// projection (out: ".agents/valtor/roadmap.md"). We MUST NOT overwrite the hand-authored file.
//   * On a case-SENSITIVE filesystem (posix) roadmap.md and ROADMAP.md are different files — no
//     conflict, we just write roadmap.md.
//   * On a case-INSENSITIVE filesystem (Windows/macOS-default) the two names resolve to the SAME
//     inode. If a differently-cased file already exists at that path AND it does not look like one
//     of our own generated boards, we REFUSE to clobber it: report the collision and exit 0
//     (a renderer reports, never blocks, and never destroys hand-authored content).
//
// RENDERER CONTRACT (registry projection):
//   * Writes ONLY its single 'out' artifact (HOME/roadmap.md). Touches nothing else in the tree.
//   * Reports, never blocks: ALWAYS exit 0 (even on an empty ledger, a missing config key, a
//     git-absent environment, or a refused/failed write — all are reported, not thrown).
//   * Reads every repo-specific value from loadConfig(); nothing repo-specific is hardcoded. The
//     only path it derives is HOME (honors $VALTOR_HOME via lib) + the projection's own filename,
//     which the registry pins for this projection.
//
// GRACEFUL DEGRADATION (the headline requirement):
//   * Empty ledger / absent items.jsonl / corrupt rows (skipped) / missing config / git-absent →
//     a VALID roadmap.md is still written + exit 0. Never a stack trace.

// We deliberately do NOT use lib's loadConfig()/readRows(): both call lib.fail() →
// process.exit(1) on a missing/corrupt config or a single corrupt jsonl row, which a try/catch
// CANNOT trap (it is a process exit, not a throw). A renderer must degrade gracefully — still
// write a valid artifact and exit 0 — so we read config + ledger with local defensive readers
// (the same reason render-readiness.mjs / index-rebuild.mjs avoid readRows()). HOME/INDEX/
// nowIso/tryGit/out are pure helpers, safe to import.
import { HOME, INDEX, CONFIG_PATH, nowIso, tryGit, out } from './lib.mjs';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

// The filename for this projection. Kept as a constant (it is the projection's identity in the
// registry: out: ".agents/valtor/roadmap.md") rather than hardcoding any repo-specific path.
const OUT_FILENAME = 'roadmap.md';

// A marker line we stamp into every generated board. Used to recognize our OWN prior output so a
// regen can safely overwrite it even on a case-insensitive filesystem, while still refusing to
// clobber a hand-authored file of a different case (e.g. ROADMAP.md).
const GENERATED_MARKER = '<!-- valtor:generated-roadmap -->';

// ---- defensive readers ------------------------------------------------------------------------

// Returns the parsed config object, or {} on absent/corrupt config — never exits the process.
function readConfigSafe() {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch {
    return {}; // corrupt config → fall back to defaults, still render
  }
}

// Reads a jsonl ledger table defensively: SKIPS any line that fails to parse, never throws, never
// exits. Absent/empty file → []. Mirrors render-readiness.mjs / index-rebuild.mjs tolerance.
function readRowsSafe(table) {
  try {
    const p = join(INDEX, `${table}.jsonl`);
    if (!existsSync(p)) return [];
    const rows = [];
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { rows.push(JSON.parse(s)); } catch { /* skip corrupt row, keep going */ }
    }
    return rows;
  } catch {
    return [];
  }
}

// ---- small helpers ----------------------------------------------------------------------------

// Keep Markdown table cells from breaking on a literal pipe or a newline.
function escMd(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}
function emptyLabel(s) { return s == null || String(s) === '' ? '(none)' : String(s); }

// Short-form a commit sha for display without assuming it is a 40-char sha (it may already be
// short, or be null/absent). Returns '—' when there is nothing to show.
function shortSha(sha) {
  const s = String(sha == null ? '' : sha).trim();
  if (!s) return '—';
  return s.length > 12 ? s.slice(0, 12) : s;
}

// Render a status as an inline code span so it lines up + reads as an enum, not prose.
function statusCell(status) {
  const s = String(status == null ? '' : status).trim();
  return s ? '`' + escMd(s) + '`' : '`(unset)`';
}

// ---- grouping ---------------------------------------------------------------------------------
// Group items by (plan_id, phase). Both default to a stable "(none)" bucket when unset so a fresh
// plan with no bucketing still renders one coherent group rather than scattering. Returns an
// ordered array of { plan_id, phase, items[] }, sorted by plan_id then phase (stable, lexical),
// with the "(none)" buckets sorted last so real plans lead.
function groupItems(items) {
  const groups = new Map(); // key -> { plan_id, phase, items[] }
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const plan_id = emptyLabel(it.plan_id);
    const phase = emptyLabel(it.phase);
    const key = `${plan_id}::${phase}`;
    if (!groups.has(key)) groups.set(key, { plan_id, phase, items: [] });
    groups.get(key).items.push(it);
  }
  const sortKey = (label) => (label === '(none)' ? '￿' : String(label).toLowerCase());
  return [...groups.values()].sort((a, b) => {
    const pa = sortKey(a.plan_id), pb = sortKey(b.plan_id);
    if (pa !== pb) return pa < pb ? -1 : 1;
    const qa = sortKey(a.phase), qb = sortKey(b.phase);
    if (qa !== qb) return qa < qb ? -1 : 1;
    return 0;
  });
}

// Within a group, order items by id (lexical, stable). A missing id sorts last so it does not
// shuffle around real ids between regens.
function sortItemsInGroup(items) {
  return [...items].sort((a, b) => {
    const ai = a && a.id != null ? String(a.id) : '￿';
    const bi = b && b.id != null ? String(b.id) : '￿';
    if (ai !== bi) return ai < bi ? -1 : 1;
    return 0;
  });
}

// ---- render -----------------------------------------------------------------------------------

function renderMarkdown({ groups, totalItems, commit, generatedAt }) {
  const lines = [];
  lines.push(GENERATED_MARKER);
  lines.push('# Roadmap — status board (generated)');
  lines.push('');
  lines.push(
    `_Generated ${generatedAt}${commit ? ` · commit \`${commit}\`` : ''} from the \`items\` ledger. ` +
    'Regenerable projection — do not hand-edit (see `ROADMAP.md` for the hand-authored build plan)._'
  );
  lines.push('');

  if (totalItems === 0) {
    // Spec: empty → "no items tracked yet".
    lines.push('no items tracked yet');
    lines.push('');
    return lines.join('\n') + '\n';
  }

  lines.push(`Tracking **${totalItems}** item${totalItems === 1 ? '' : 's'} across **${groups.length}** group${groups.length === 1 ? '' : 's'} (plan × phase).`);
  lines.push('');

  for (const g of groups) {
    lines.push(`## ${escMd(g.plan_id)} · phase ${escMd(g.phase)}`);
    lines.push('');
    lines.push('| Status | ID | Goal | Last seen commit |');
    lines.push('|---|---|---|---|');
    for (const it of sortItemsInGroup(g.items)) {
      const id = it && it.id != null ? escMd(it.id) : '(no id)';
      const goal = escMd(it && (it.goal || it.text) ? (it.goal || it.text) : '');
      lines.push(`| ${statusCell(it && it.status)} | ${id} | ${goal || '—'} | ${shortSha(it && it.last_seen_commit)} |`);
    }
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

// ---- clobber guard ----------------------------------------------------------------------------
// On a case-insensitive filesystem, OUT_FILENAME may resolve to an existing file of a different
// case (e.g. the hand-authored ROADMAP.md). We must never destroy hand-authored content.
//
// Returns { safe:true } when it is safe to write, or { safe:false, reason, collidesWith } when a
// differently-cased, non-generated file occupies the same path. We treat it as safe when:
//   * no directory entry case-collides with OUT_FILENAME (posix: ROADMAP.md and roadmap.md coexist
//     as separate files; we only ever touch our own roadmap.md), OR
//   * the only colliding entry is our exact filename (a prior generated board — overwrite is fine), OR
//   * the colliding file already carries our GENERATED_MARKER (it is our own output).
function clobberGuard(dir) {
  let entries;
  try {
    if (!existsSync(dir)) return { safe: true };
    entries = readdirSync(dir);
  } catch {
    // Can't list the dir → let the write attempt itself surface any error (still exit 0).
    return { safe: true };
  }
  const wantLower = OUT_FILENAME.toLowerCase();
  for (const name of entries) {
    if (name.toLowerCase() !== wantLower) continue;     // not a case-collision with our target
    if (name === OUT_FILENAME) continue;                 // exact match = our own prior board, fine
    // A differently-cased file shares this path. Determine whether it is our own generated output.
    let isOurs = false;
    try {
      const content = readFileSync(join(dir, name), 'utf8');
      isOurs = content.includes(GENERATED_MARKER);
    } catch {
      isOurs = false; // unreadable → treat as hand-authored, do not clobber
    }
    if (!isOurs) {
      return {
        safe: false,
        reason:
          `target ${OUT_FILENAME} case-collides with existing hand-authored file ${name} on this ` +
          'case-insensitive filesystem; refusing to overwrite it',
        collidesWith: name,
      };
    }
  }
  return { safe: true };
}

// ---- main -------------------------------------------------------------------------------------

function main() {
  const cfg = readConfigSafe(); // read for forward-compat / parity with other renderers; defaults are self-contained
  void cfg;

  const items = readRowsSafe('items');

  const groups = groupItems(items);

  // Best-effort current commit for provenance. git-absent → omit (graceful degradation).
  const head = tryGit('rev-parse --short HEAD');
  const commit = head && head.ok && head.out ? head.out : null;

  const generatedAt = nowIso();
  const md = renderMarkdown({ groups, totalItems: items.length, commit, generatedAt });

  // Write the single 'out' artifact: HOME/roadmap.md. Ensure HOME exists first. A refused or
  // failed write is REPORTED (not thrown); a renderer never blocks the loop and never exits non-0.
  const outPath = join(HOME, OUT_FILENAME);
  const dir = dirname(outPath);

  let written = false;
  let writeError = null;
  let refused = null;
  let collidesWith = null;
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const guard = clobberGuard(dir);
    if (!guard.safe) {
      refused = guard.reason;
      collidesWith = guard.collidesWith || null;
    } else {
      writeFileSync(outPath, md);
      written = true;
    }
  } catch (e) {
    writeError = e && e.message ? e.message : String(e);
  }

  out({
    ok: true,
    out: outPath,
    written,
    ...(refused ? { refused, collidesWith } : {}),
    ...(writeError ? { writeError } : {}),
    items: items.length,
    groups: groups.length,
    empty: items.length === 0,
    file: basename(outPath),
  });
  process.exit(0);
}

try {
  main();
} catch (e) {
  // Last-resort guard: the hard rules forbid an unhandled stack trace, and a renderer never blocks.
  // Emit clean JSON and exit 0 (report-only).
  out({ ok: true, written: false, error: `render-roadmap degraded: ${e && e.message ? e.message : String(e)}` });
  process.exit(0);
}
