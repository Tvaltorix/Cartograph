#!/usr/bin/env node
// package.mjs — the Valtor chip ejector (SCHEMA §8 "Portability, placement & rebuild").
//
//   node package.mjs --out <dir>   copy the PORTABLE Valtor file set into <dir>, preserving
//                                  structure, and write a repo-neutral valtor.config.template.json
//                                  (NOT the host repo's valtor.config.json).
//   node package.mjs               no --out: print the manifest (the files that WOULD be copied)
//                                  as JSON. Pure dry-run, touches nothing.
//
// This is how Valtor transfers to another repo. The PORTABLE set is the universal mechanism
// (skill + agents + SCHEMA/registry/ROADMAP + bin/ scripts). It deliberately EXCLUDES the
// per-repo seam (valtor.config.json) and all ledger/runtime data (index/*, *.sqlite, *.lock,
// run-journal.jsonl) — those are regenerated/rewritten in the destination repo.
//
// Graceful degradation: a missing source file or dir is reported as { present:false } and skipped,
// never a throw. A repo missing half the chip still ejects what it has + a clean manifest. The
// valtor.config.template.json is generated from the live config when present, or from built-in
// defaults when the config is absent/corrupt — either way it ships blanked, repo-neutral fields.
import { cpSync, mkdirSync, writeFileSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { HOME, CONFIG_PATH, existsSync, args, ok, fail } from './lib.mjs';

// ---------------------------------------------------------------------------
// 1. The portable file set, declared relative to the REPO ROOT (cwd).
//    `kind:'dir'`  -> recursive copy (with the exclusion filter below).
//    `kind:'file'` -> single-file copy.
//    `kind:'glob'` -> shell-glob a directory for matching files (e.g. valtor-*.md).
//    HOME may be overridden by VALTOR_HOME for isolated dry-runs, so derive the
//    .agents path from it rather than hardcoding ".agents/valtor".
// ---------------------------------------------------------------------------
const J = HOME; // e.g. ".agents/valtor" (or a temp home under VALTOR_HOME)

const PORTABLE = [
  { kind: 'dir', src: '.claude/skills/valtor' },
  { kind: 'glob', dir: '.claude/agents', match: /^valtor-.*\.md$/, label: '.claude/agents/valtor-*.md' },
  { kind: 'file', src: join(J, 'SCHEMA.md') },
  { kind: 'file', src: join(J, 'registry.json') },
  { kind: 'file', src: join(J, 'ROADMAP.md') },
  { kind: 'file', src: join(J, 'MODES.md') },
  { kind: 'file', src: join(J, 'README.md') }, // top-level README if a repo keeps one here
  { kind: 'dir', src: join(J, 'bin') },         // includes lib.mjs + every *.mjs + bin/README.md
];

// NEVER copy these — repo-specific seam + ledger/runtime data. Used both as a top-level
// skip list and as the per-entry filter for recursive dir copies (defense in depth: even if
// a *.sqlite/lock/run-journal somehow lives under a copied dir, it is filtered out).
const EXCLUDE_NAMES = new Set([
  'valtor.config.json',     // the per-repo seam — a template is generated instead
  'valtor.lock',
  'run-journal.jsonl',
  'run_journal.jsonl',
]);
const EXCLUDE_EXT = ['.sqlite', '.sqlite-shm', '.sqlite-wal', '.lock'];
// Directory basenames never copied (ledger data lives here).
const EXCLUDE_DIRS = new Set(['index']);

function isExcluded(absOrName) {
  const name = String(absOrName).split(/[\\/]/).pop();
  if (EXCLUDE_NAMES.has(name)) return true;
  if (EXCLUDE_EXT.some((e) => name.endsWith(e))) return true;
  return false;
}

// cpSync filter: return false to skip an entry (and, for a dir, its whole subtree).
function copyFilter(srcPath) {
  const name = srcPath.split(/[\\/]/).pop();
  if (EXCLUDE_DIRS.has(name)) return false;
  if (isExcluded(srcPath)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 2. Build the manifest: walk each portable entry and resolve to concrete files
//    that are present on disk. Missing entries are recorded { present:false }.
//    Returns { files:[{ src, present, kind }], missing:[...], generated:[...] }.
// ---------------------------------------------------------------------------
function walkDir(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir -> contribute nothing, no throw
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (EXCLUDE_DIRS.has(ent.name)) continue;
      walkDir(full, acc);
    } else if (ent.isFile()) {
      if (isExcluded(full)) continue;
      acc.push(full.split(sep).join('/'));
    }
  }
}

function buildManifest() {
  const files = [];     // concrete source files that exist + will be copied
  const missing = [];   // declared portable paths that are absent on disk

  for (const entry of PORTABLE) {
    if (entry.kind === 'file') {
      const present = existsSync(entry.src) && safeIsFile(entry.src);
      if (present && !isExcluded(entry.src)) {
        files.push({ src: entry.src.split(sep).join('/'), kind: 'file' });
      } else {
        missing.push(entry.src.split(sep).join('/'));
      }
    } else if (entry.kind === 'dir') {
      if (!existsSync(entry.src) || !safeIsDir(entry.src)) {
        missing.push((entry.src + '/').split(sep).join('/'));
        continue;
      }
      const acc = [];
      walkDir(entry.src, acc);
      if (acc.length === 0) {
        // dir exists but is empty (or fully excluded) — note it, don't fail.
        missing.push((entry.src + '/ (empty)').split(sep).join('/'));
      }
      for (const f of acc) files.push({ src: f, kind: 'dir-member' });
    } else if (entry.kind === 'glob') {
      let matched = [];
      try {
        matched = readdirSync(entry.dir, { withFileTypes: true })
          .filter((d) => d.isFile() && entry.match.test(d.name))
          .map((d) => join(entry.dir, d.name).split(sep).join('/'));
      } catch {
        matched = [];
      }
      if (matched.length === 0) {
        missing.push(entry.label);
      } else {
        for (const m of matched) {
          if (!isExcluded(m)) files.push({ src: m, kind: 'glob-member' });
        }
      }
    }
  }

  // De-dup (a path could be reachable via two declarations) + stable sort.
  const seen = new Set();
  const deduped = [];
  for (const f of files) {
    if (seen.has(f.src)) continue;
    seen.add(f.src);
    deduped.push(f);
  }
  deduped.sort((a, b) => a.src.localeCompare(b.src));

  return { files: deduped, missing };
}

function safeIsFile(p) { try { return statSync(p).isFile(); } catch { return false; } }
function safeIsDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }

// ---------------------------------------------------------------------------
// 3. The generated, repo-NEUTRAL config template. Built from the live config's
//    structural keys when readable, but every repo-specific value (archGates /
//    extractors / conflictZones / stakeholders, plus a few others that name a
//    repo) is BLANKED to a placeholder + carries a _doc comment. A fresh repo
//    edits THIS file (renamed to valtor.config.json) as its only per-repo work.
// ---------------------------------------------------------------------------
function buildConfigTemplate() {
  // Start from a built-in neutral skeleton so this works even with NO live config.
  const template = {
    _doc: 'VALTOR CONFIG TEMPLATE — rename to valtor.config.json and fill in for THIS repo. This is the ONLY per-repo seam; the universal files (SCHEMA.md, registry.json, the skill + agents, bin/) never name a repo. Blank/placeholder fields below are marked with a sibling _doc. SCHEMA.md explains every key.',
    version: '0.2.0',
    engine: 'valtor',
    home: '.agents/valtor',
    masterContext: 'CLAUDE.md',
    _doc_masterContext: 'Point at THIS repo\'s primary context doc (e.g. README.md, ARCHITECTURE.md, CLAUDE.md).',

    humanInteraction: {
      _doc: 'S-ASK interaction mode. confer = discussable prose Decision Brief (DEFAULT); quickpick = blocking form, trivial/binary only.',
      mode: 'confer',
      quickpickFor: ['trivial-binary-confirmation'],
      briefEndsWithRecapMenu: true,
      onConverge: 'log-and-proceed; surface one-line record in next review summary',
      recordTo: 'decisions-ledger',
      graduateStandingTo: ['ADR', 'memory'],
    },

    index: {
      path: '.agents/valtor/index/valtor.sqlite',
      exports: [
        '.agents/valtor/index/items.jsonl',
        '.agents/valtor/index/decisions.jsonl',
        '.agents/valtor/index/transitions.jsonl',
        '.agents/valtor/index/plans.jsonl',
        '.agents/valtor/index/graph.jsonl',
        '.agents/valtor/index/concerns.jsonl',
      ],
      runJournal: '.agents/valtor/index/run-journal.jsonl',
      embeddings: 'auto',
      rebuildFromExport: true,
    },

    lock: {
      path: '.agents/valtor/index/valtor.lock',
      staleAfter: '30m',
      fields: ['instance_id', 'host', 'pid', 'started_at', 'current_state', 'plan_path', 'heartbeat_at'],
    },

    budget: {
      perItemMaxRetries: 3, perItemDebugIterations: 3, maxDeployAttemptsPerItem: 3,
      maxGVRetriesPerItem: 3, reproduceAttempts: 3, maxNoProgressCycles: 2,
      perWaveWallClockMinutes: 90, totalSessionTokenCeiling: null, onExceed: 'HALT-ASK',
      transientSignatures: ['429', 'throttl', 'timeout', 'ETIMEDOUT', 'ECONNRESET'],
    },

    gitPolicy: {
      _doc: 'Set defaultBranch + branchPrefix for THIS repo.',
      defaultBranch: 'main', requireBranchOffDefault: true, branchPrefix: 'loop/',
      neverForcePush: true, selfEditRequiresSeparateCommit: true, mergeToMainAt: 'S11', openPr: false,
    },

    reconcileSweep: {
      _doc: 'PLACEHOLDER — set targets to THIS repo\'s anchored docs (the ones a new plan could contradict). memoryDir is absolute + machine-specific; set or remove.',
      targets: ['<DOC-GLOB-1>', '<DOC-GLOB-2>'],
      memoryDir: '<ABSOLUTE-PATH-TO-MEMORY-DIR-OR-OMIT>',
      skip: [],
      blockOn: 'contradiction', autoFix: 'cosmetic-drift',
    },

    conflictZones: {
      _doc: 'PLACEHOLDER — the files multiple items fan into (sole-writer = orchestrator). Seed by hand or let autoComputeFrom derive them from the import graph + CI/IaC fan-in.',
      paths: ['<SHARED-INFRA-FILE>', '<SHARED-CI-WORKFLOW-GLOB>', '<MASTER-CONTEXT-DOC>'],
      autoComputeFrom: 'import-graph + CI/IaC fan-in',
    },

    archGates: {
      _doc: 'PLACEHOLDER — THIS repo\'s LOCKED architecture + security invariants (G2). Blank or delete any gate that does not apply. newLanguageRequiresAdr etc. are intent-bearing toggles.',
      regionLock: { _doc: 'Allowed deploy regions; list documented exceptions.', allowed: [], exceptions: [] },
      languagePolicy: { _doc: 'Default language + documented exceptions per layer.', adr: '<ADR-ID>', default: '<LANG>', exceptions: [], newLanguageRequiresAdr: true },
      phaseBoundary: { _doc: 'Scope authority + the in-scope vs out-of-scope feature lists (scope-creep is the top risk).', authority: '<SCOPE-AUTHORITY>', scopeCreepIsTopRisk: true, phase1: [], phase2: [] },
      kms: { _doc: 'Managed-key inventory; new key requires sign-off.', managedKeys: 0, newKeyRequiresAdr: true },
      identity: { _doc: 'MFA / domain-gate / auth invariants.', mfaRequired: false, domainGate: '<EMAIL-DOMAIN-OR-OMIT>', adr: [] },
      logging: { _doc: 'No-PII-in-logs + required structured-log fields.', noPii: true, required: [] },
    },

    dbConstraintPrinciple: {
      _doc: 'Set migrationsGlob to THIS repo\'s migration file glob (or disable if no SQL migrations).',
      enabled: true,
      rule: 'any column with a domain (enum|regex|range|fk) MUST carry a DB-level constraint (ENUM type|CHECK|FOREIGN KEY|unique index|generated). serde/validation is the boundary, not the column.',
      migrationsGlob: '<MIGRATIONS-GLOB-OR-OMIT>',
    },
    dataSafety: { _doc: 'Tables holding REAL data (destructive migration -> HALT).', realDataTables: [], requireDownMigration: true, migrateBeforeDeploy: true },

    extractors: {
      _doc: 'PLACEHOLDER — the structural seams the detectors + system-map read. Each is OPTIONAL: omit a seam and that edge kind degrades cleanly. Rewrite globs/files/patterns for THIS repo\'s frameworks.',
      backendRoutes: { glob: '<BACKEND-ROUTES-GLOB>', pattern: '<ROUTE-DEFINITION-REGEX>' },
      uiCallSites: { file: '<UI-API-CLIENT-FILE>', _doc_apiScopePrefixes: 'OPTIONAL — if the UI client namespaces calls under /api/<scope>/ while the backend registers routes WITHOUT that prefix, list the scope tokens (e.g. ["workforce","client"]) so route/UI matching lines the two namespaces up. Omit for no stripping.', apiScopePrefixes: [] },
      eventLockstep: { emitter: { glob: '<EVENT-EMITTER-GLOB>', pattern: '<EMIT-REGEX>' }, fanout: '<FANOUT-FILE>', portal: '<UI-SUBSCRIBER-FILE>' },
      migrations: { glob: '<MIGRATIONS-GLOB-OR-OMIT>' },
      gatewayRouteMap: { file: '<API-GATEWAY-MAP-FILE>', pattern: '<INTEGRATION-REGEX>' },
    },

    deployGates: {
      _doc: 'Wire to THIS repo\'s deploy scripts/CI. autoDetect + scaffoldIfAbsent let Valtor stand up a minimal gate when a script is missing.',
      smokeTest: '<SMOKE-TEST-SCRIPT-OR-OMIT>',
      negativeAuthz: '<NEGATIVE-AUTHZ-SCRIPT-OR-OMIT>',
      ciWorkflow: '<CI-WORKFLOW-FILE-OR-OMIT>',
      oneDeployAtATime: true, autoDetect: true, scaffoldIfAbsent: true, notifyOutcomeToChat: true,
      rollback: { strategy: 'git-revert-on-branch', lastGreenRef: 'auto', freezeWaveOnRed: true },
    },

    readinessModel: { dimensions: ['BUILD', 'TEST', 'INTEGRATION', 'DEPLOY', 'DEMO-READY', 'SECURITY-CLEAR'], overall: 'min' },
    priorityWeights: { sortKey: ['severity', 'priority'], withinDependencyLevel: true },
    domainMap: { _doc: 'PLACEHOLDER — map path globs to THIS repo\'s domains (drives bucketing on the board).' },
    demoPath: { _doc: 'OPTIONAL — a demo dry-run file, if the repo has one.', dryRunFile: '<DEMO-DRY-RUN-FILE-OR-OMIT>' },
    e2e: { _doc: 'OPTIONAL — a declared user/demo flow makes G-E2E blocking.', dryRun: '<E2E-DRY-RUN-FILE-OR-OMIT>', flows: [] },

    anticipatedQa: {
      _doc: 'Stakeholder-lens review at phase completion + on demand. lenses + firesOn are universal; the stakeholders array below is the repo-specific part to fill in.',
      lenses: ['stakeholder', 'skeptic'],
      firesOn: ['phase-completion', 'on-demand'],
      learn: true,
      concernsLedger: '.agents/valtor/index/concerns.jsonl',
    },
    stakeholders: [
      { _doc: 'PLACEHOLDER — one entry per audience whose questions the Anticipated-Q&A brief should predict. id is a slug; who is the human/role; cares is what they probe.', id: '<STAKEHOLDER-SLUG>', who: '<NAME-OR-ROLE>', cares: ['<CONCERN-1>', '<CONCERN-2>'] },
    ],

    uiBar: { _doc: 'OPTIONAL — the host\'s locked visual bar the designer agent grounds in (density rules, design tokens, status-color source, brand-copy + legacy click-path conventions). Fill in for a repo with a frontend; omit for a backend-only repo.' },
    nfrBudgets: { _doc: 'OPTIONAL — non-functional budgets for G-NFR (perf/a11y).', a11yLevel: 'WCAG-AA' },
    map: { blastRadiusDepth: 2, sharedNodeKinds: ['table', 'event_detail_type', 'service'], renderInWaveSummary: true, provenanceEdges: true, requireSeams: [], optionalSeams: ['gatewayRouteMap', 'eventLockstep'] },
    blockerStaleHours: 48,

    propagation: {
      _doc: 'PLACEHOLDER — where G7 propagates docs/ADR/memory for THIS repo. Build isn\'t done until these match reality.',
      claudeMd: '<MASTER-CONTEXT-DOC>', adrDir: '<ADR-DIR-OR-OMIT>', timeline: '<TIMELINE-DOC-OR-OMIT>',
      failures: '<FAILURES-DOC-OR-OMIT>', stateDir: '<STATE-DIR-OR-OMIT>',
      systemMap: '.agents/valtor/system-map.md', memory: true,
    },

    done: {
      tier: 'plan-complete+repo-healthy',
      autoUpgradeWhenRegistered: { deployGateActive: 'plan+repo-healthy+deploy-green' },
      reentrant: true,
    },
  };

  // If a live config is readable, carry over only the UNIVERSAL structural blocks
  // verbatim (they don't name the repo), so a template tracks the host's schema
  // version + budget/lock tuning. The repo-specific blocks stay blanked above.
  const carryUniversal = ['version', 'humanInteraction', 'index', 'lock', 'budget', 'readinessModel', 'priorityWeights', 'map', 'done'];
  try {
    if (existsSync(CONFIG_PATH)) {
      const live = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      for (const k of carryUniversal) {
        if (live[k] !== undefined) template[k] = live[k];
      }
    }
  } catch {
    // corrupt/unreadable live config -> keep the built-in neutral skeleton. No throw.
  }

  return template;
}

// The .gitignore stanza note that travels with the chip (SCHEMA §8). Written as a
// sidecar so the destination repo can paste it into its own .gitignore.
const GITIGNORE_NOTE = `# --- Valtor .gitignore stanza (paste into the destination repo's .gitignore) ---
# The methodology must be shareable, so selectively un-ignore the committed Valtor
# surfaces, but git-ignore the rebuildable SQLite index, the lock, and the run-journal.
.claude/*
!.claude/skills/
!.claude/agents/
!.claude/commands/
!.claude/settings.json

# Valtor index + lock + run-journal are rebuildable/local — commit the JSONL exports, not these
.agents/valtor/index/*.sqlite
.agents/valtor/index/*.sqlite-*
.agents/valtor/index/valtor.lock
.agents/valtor/index/run-journal.jsonl
`;

// ---------------------------------------------------------------------------
// 4. main
// ---------------------------------------------------------------------------
function getOutDir(argv) {
  // Accept both forms: `--out <dir>` (space-separated) and `--out=<dir>` (equals).
  // The equals form is a common CLI convention; without handling it, `--out=./dest`
  // would silently fall through to the dry-run path and copy nothing.
  const eq = argv.find((a) => a.startsWith('--out='));
  if (eq !== undefined) {
    const v = eq.slice('--out='.length);
    if (!v) return fail('--out requires a directory argument');
    return v;
  }
  const i = argv.indexOf('--out');
  if (i === -1) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) return fail('--out requires a directory argument');
  return v;
}

function main() {
  const argv = args();
  const outDir = getOutDir(argv);
  const manifest = buildManifest();

  // The two GENERATED artifacts (always part of the eject, never copied from source).
  const generated = ['valtor.config.template.json', '.valtor-gitignore-note.txt'];

  if (!outDir) {
    // Dry-run: print the manifest only. Touch nothing. Generated artifacts land under
    // <out>/.agents/valtor/ when --out is given; here we just name them.
    return ok({
      mode: 'manifest',
      out: null,
      wouldCopy: manifest.files.map((f) => f.src),
      wouldGenerate: generated.map((g) => '.agents/valtor/' + g),
      missing: manifest.missing,
      excluded: {
        names: [...EXCLUDE_NAMES],
        ext: EXCLUDE_EXT,
        dirs: [...EXCLUDE_DIRS],
        note: 'valtor.config.json + index/* + *.sqlite/lock/run-journal are NEVER copied (per-repo seam + ledger data).',
      },
      fileCount: manifest.files.length,
    });
  }

  // --out given: perform the eject.
  const copied = [];
  const skipped = [];

  // Resolve the destination root. We preserve each source's repo-relative path
  // under <outDir>, so e.g. .agents/valtor/bin/lib.mjs -> <outDir>/.agents/valtor/bin/lib.mjs.
  try {
    mkdirSync(outDir, { recursive: true });
  } catch (e) {
    return fail(`could not create --out dir ${outDir}: ${e.message}`);
  }

  for (const f of manifest.files) {
    const dest = join(outDir, f.src);
    try {
      mkdirSync(dirname(dest), { recursive: true });
      // Per-file copy (manifest already expanded dirs into member files and applied
      // the exclusion filter). The cpSync filter is belt-and-suspenders for any
      // future dir-level copy; here we copy concrete files.
      cpSync(f.src, dest, { recursive: false, filter: copyFilter });
      copied.push(f.src);
    } catch (e) {
      skipped.push({ src: f.src, reason: e.message });
    }
  }

  // Write the two generated artifacts under <outDir>/.agents/valtor/.
  const homeRel = '.agents/valtor';
  const writeGenerated = [];

  const tplPath = join(outDir, homeRel, 'valtor.config.template.json');
  try {
    mkdirSync(dirname(tplPath), { recursive: true });
    writeFileSync(tplPath, JSON.stringify(buildConfigTemplate(), null, 2) + '\n');
    writeGenerated.push(join(homeRel, 'valtor.config.template.json').split(sep).join('/'));
  } catch (e) {
    skipped.push({ src: 'valtor.config.template.json', reason: e.message });
  }

  const notePath = join(outDir, homeRel, '.valtor-gitignore-note.txt');
  try {
    mkdirSync(dirname(notePath), { recursive: true });
    writeFileSync(notePath, GITIGNORE_NOTE);
    writeGenerated.push(join(homeRel, '.valtor-gitignore-note.txt').split(sep).join('/'));
  } catch (e) {
    skipped.push({ src: '.valtor-gitignore-note.txt', reason: e.message });
  }

  return ok({
    mode: 'eject',
    out: outDir.split(sep).join('/'),
    copied,
    generated: writeGenerated,
    skipped,
    missing: manifest.missing,
    copiedCount: copied.length,
    note: 'Per-repo seam was NOT copied — rename valtor.config.template.json -> valtor.config.json and fill it in for the destination repo, then run init.mjs.',
  });
}

main();
