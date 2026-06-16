#!/usr/bin/env node
// Pre-commit hook: run `oxfmt` on staged files and re-stage the results.
//
// Design notes
// ------------
// * Extension set is not hard-coded. `oxfmt` silently skips files it doesn't
//   recognize when at least one recognized file is in the batch, and exits
//   with status 2 ("Expected at least one target file") when every file is
//   unknown. We pass the full staged list and treat exit 2 as a no-op so this
//   hook automatically tracks whatever `oxfmt` supports (currently JS/TS/JSX,
//   JSON/JSONC/JSON5, Markdown/MDX, YAML, HTML/Vue, CSS/SCSS/Less, GraphQL,
//   Handlebars, TOML, …).
//
// * Partially-staged files are NOT formatted. If a file has both staged and
//   unstaged changes, formatting it in place and then `git add`-ing it would
//   silently pull the unstaged edits into the commit. We skip those and emit
//   a warning so the user can stash or stage explicitly.
//
// * Only Added / Copied / Modified / Renamed index entries are considered.
//   Deletes and typechanges are ignored.
//
// Intentionally zero runtime deps — invoked by `simple-git-hooks`.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);

// Exit code `oxfmt` uses when no passed path matches a supported parser.
const OXFMT_NO_TARGETS_EXIT = 2;

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    ...opts,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function runGitNameList(args) {
  const out = run("git", [...args, "-z"]);
  if (out.status !== 0) {
    process.stderr.write(out.stderr || `git ${args.join(" ")} failed\n`);
    process.exit(out.status ?? 1);
  }
  return out.stdout.split("\0").filter(Boolean);
}

// ACMR = Added, Copied, Modified, Renamed — excludes Deleted (D) and
// Typechanged (T) so we never try to format paths that aren't in the tree.
const stagedAll = runGitNameList(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);

// Working-tree-vs-index diff. Any path here has unstaged modifications.
const unstaged = new Set(runGitNameList(["diff", "--name-only"]));

// Rename entries come through as "old\0new" with `-z`; both halves survive
// the split. The old half won't exist on disk — drop it.
const stagedOnDisk = stagedAll.filter((p) => existsSync(resolve(REPO_ROOT, p)));

const safe = [];
const skipped = [];
for (const p of stagedOnDisk) {
  if (unstaged.has(p)) {
    skipped.push(p);
  } else {
    safe.push(p);
  }
}

for (const p of skipped) {
  process.stderr.write(`oxfmt: skipping partially-staged file (has unstaged changes): ${p}\n`);
}

if (safe.length === 0) {
  process.exit(0);
}

const fmt = run("pnpm", ["exec", "oxfmt", "--", ...safe], {
  stdio: ["ignore", "inherit", "inherit"],
});
if (fmt.status === OXFMT_NO_TARGETS_EXIT) {
  // No staged file had a supported parser. Nothing to do.
  process.exit(0);
}
if (fmt.status !== 0) {
  process.exit(fmt.status ?? 1);
}

// Re-stage. Paths with no on-disk change are a no-op for `git add`; paths
// `oxfmt` rewrote pick up the new content. Partially-staged files were
// already excluded above, so this cannot pull in unstaged edits.
const add = run("git", ["add", "--", ...safe], {
  stdio: ["ignore", "inherit", "inherit"],
});
if (add.status !== 0) {
  process.exit(add.status ?? 1);
}
