#!/usr/bin/env node
// git-policy.mjs — Layer-A item A2 / G2 branch policy.
//
//   node git-policy.mjs check          -> if requireBranchOffDefault && cur==defaultBranch: block (HALT) with remedy
//   node git-policy.mjs branch <slug>  -> create+checkout branchPrefix+slug off defaultBranch (refuses force/push/reset)
//
// All repo-specific values come from config.gitPolicy. Never force-pushes, never resets, never mutates history.
import { loadConfig, tryGit, ok, fail, args } from './lib.mjs';

const argv = args();
const sub = argv[0];

if (!sub || (sub !== 'check' && sub !== 'branch')) {
  fail("usage: git-policy.mjs <check|branch> [slug]", { got: sub ?? null });
}

const config = loadConfig();
const gp = config.gitPolicy;
if (!gp || typeof gp !== 'object') {
  fail("config.gitPolicy is missing or not an object");
}

const defaultBranch = gp.defaultBranch;
const branchPrefix = gp.branchPrefix;

if (!defaultBranch) fail("config.gitPolicy.defaultBranch is not set");

// A git ref token (branch name component) that is also safe to interpolate into a shell command line
// on BOTH cmd.exe and POSIX sh. Allow-list only: letters, digits, dot, underscore, dash, slash.
// This deliberately excludes every shell metacharacter ( ; & | $ ` ( ) < > ' " { } [ ] ~ ^ : ? * \ % ! newline )
// so a `branch <slug>` invocation can never chain/substitute a second command (e.g. an injected push/reset/force).
// Empty string is never safe. We pair this with the structural ref rules below.
const REF_SAFE = /^[A-Za-z0-9._/-]+$/;

// Confirm we can talk to git AND that this is a git repo. tryGit degrades gracefully.
const inside = tryGit('rev-parse --is-inside-work-tree');
if (!inside.ok) {
  fail("git unavailable or not a git repository", { gitError: inside.err });
}

if (sub === 'check') {
  const cur = tryGit('rev-parse --abbrev-ref HEAD');
  if (!cur.ok) {
    fail("could not resolve current branch", { gitError: cur.err });
  }
  const branch = cur.out;
  if (gp.requireBranchOffDefault && branch === defaultBranch) {
    // HALT case 7-adjacent: on default branch, work must branch off first.
    fail("on default branch — work must branch off first", {
      onDefault: true,
      branch,
      defaultBranch,
      remedy: "create a " + (branchPrefix ?? "") + "<slug> branch first",
    });
  }
  ok({ branch, onDefault: false, defaultBranch });
}

// sub === 'branch'
const slug = argv[1];
if (!slug) {
  fail("branch requires a <slug> argument");
}
// Safety: the slug is interpolated into a shell command line via lib's git()/execSync. A deny-list of
// "git-ref-unsafe" characters is NOT sufficient — the threat is the SHELL, not just the refname grammar.
// On cmd.exe `&` `|` chain commands; on POSIX sh `; & | $ ` ( ) < >` chain/substitute — several need NO
// whitespace, so a space-only check fails open and could inject a push/reset/force. Use a strict allow-list
// (REF_SAFE) that is simultaneously shell-safe on both shells AND a valid branch-name charset, then layer the
// structural git-ref rules ("..", leading/trailing slash, ".lock" suffix, "@{", leading "-") on top.
const structurallyUnsafe =
  slug.includes('..') ||
  slug.includes('@{') ||
  slug.startsWith('/') ||
  slug.endsWith('/') ||
  slug.endsWith('.lock') ||
  slug.startsWith('-');
if (!REF_SAFE.test(slug) || structurallyUnsafe) {
  fail("unsafe slug — allowed chars are letters/digits/._/- only, no '..', no leading/trailing '/', no '.lock' suffix, no leading '-'", { slug });
}

if (typeof branchPrefix !== 'string') {
  fail("config.gitPolicy.branchPrefix is not set (expected a string, e.g. \"loop/\")");
}

// The prefix and base branch are ALSO interpolated into the shell command line. They come from config, not
// user input, but a stray space/metachar in the config would otherwise produce a confusing shell failure (or,
// worst case, an injection). Validate them with the same allow-list — fail closed with a clear config error.
// (Prefix may be empty per spec; if non-empty it must be ref/shell-safe.)
if (branchPrefix !== '' && !REF_SAFE.test(branchPrefix)) {
  fail("config.gitPolicy.branchPrefix contains unsafe characters (allowed: letters/digits/._/-)", { branchPrefix });
}
if (!REF_SAFE.test(defaultBranch)) {
  fail("config.gitPolicy.defaultBranch contains unsafe characters (allowed: letters/digits/._/-)", { defaultBranch });
}

const baseRef = defaultBranch;
const branch = branchPrefix + slug;

// Final defense: the composed branch name must still be wholly allow-list-safe before it touches the shell.
if (!REF_SAFE.test(branch)) {
  fail("composed branch name contains unsafe characters", { branch });
}

// Create + checkout. Never push/reset/force — creation only.
const created = tryGit(`checkout -b ${branch} ${baseRef}`);
if (created.ok) {
  ok({ branch, baseRef, action: "created" });
}

// Already-exists path: just check it out (no history mutation).
const existing = tryGit(`checkout ${branch}`);
if (existing.ok) {
  ok({ branch, baseRef, action: "checked-out", note: "branch already existed" });
}

fail("could not create or checkout branch", {
  branch,
  baseRef,
  createError: created.err,
  checkoutError: existing.err,
});
