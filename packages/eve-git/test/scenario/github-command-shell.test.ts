import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseCommand } from "../../extension/lib/github-shell.ts";
import { shellQuote } from "../../extension/lib/shell.ts";

/** Runs `script` in an empty-environment temporary directory that holds `a.md`, `b.md`, and `x`. */
function shellRun(argv: readonly string[], script: string) {
  const cwd = mkdtempSync(join(tmpdir(), "eve-gh-quote-"));
  try {
    for (const file of ["a.md", "b.md", "x"]) writeFileSync(join(cwd, file), "");
    const result = spawnSync(argv[0]!, [...argv.slice(1), script], {
      cwd,
      encoding: "utf8",
      env: { HOME: cwd, PATH: "/usr/bin:/bin" },
    });
    return { status: result.status, argv: result.stdout.split("\0").slice(0, -1) };
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
}

test("single-quoted argv survives sh and bash -lc unchanged, and NUL never reaches it", () => {
  const argv = [
    "$(id)",
    "`id`",
    "a;b && c | d > e",
    "line\nbreak",
    `'"'"'`,
    "it's",
    "${HOME} $HOME ~ * ?",
    "",
    " padded ",
    "\\",
  ];
  const script = `printf '%s\\0' ${argv.map(shellQuote).join(" ")}`;
  for (const shell of [
    ["sh", "-c"],
    ["bash", "-lc"],
  ]) {
    const result = shellRun(shell, script);
    assert.equal(result.status, 0, shell.join(" "));
    assert.deepEqual(result.argv, argv, shell.join(" "));
  }
  assert.throws(() => parseCommand("gh pr comment 1 --body 'a\0b'"), /NUL character/u);
});
