import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Each fake CLI logs its argv and prints the session event its real CLI would.
const harnesses = [
  {
    cli: "claude",
    args: (prompt) => ["--print", "--model", "m", prompt],
    event: {},
    followUp: (prompt) => ["--continue", "--print", "--model", "m", prompt],
  },
  {
    cli: "codex",
    args: (prompt) => ["exec", "--profile", "default", "--json", prompt],
    event: { type: "thread.started", thread_id: "thread-1" },
    followUp: (prompt) => ["exec", "--profile", "default", "--json", "resume", "thread-1", prompt],
  },
  {
    cli: "opencode",
    args: (prompt) => ["run", prompt, "--format", "json"],
    event: { type: "step_start", sessionID: "ses_1" },
    followUp: (prompt) => ["run", prompt, "--session", "ses_1", "--format", "json"],
  },
];

for (const harness of harnesses) {
  test(`${harness.cli} sends follow-up turns in the session the first prompt started`, () => {
    const root = mkdtempSync(join(tmpdir(), "eve-turns-shim-"));
    try {
      const { run, calls } = install(root, harness, ["First.", "Second.", "Third."]);

      const result = run(harness.args("First.\n"));
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(calls(), [
        harness.args("First.\n"),
        harness.followUp("Second."),
        harness.followUp("Third."),
      ]);
      assert.equal(result.stdout.split("\n").filter(Boolean).length, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("passes other invocations through and stops at a failed turn", () => {
  const root = mkdtempSync(join(tmpdir(), "eve-turns-shim-"));
  try {
    const { run, calls } = install(root, harnesses[0], ["First.", "Second."]);
    assert.equal(run(["--version"]).status, 0);
    assert.deepEqual(calls(), [["--version"]]);

    const failed = run(["--print", "First."], { FAKE_EXIT: "3" });
    assert.equal(failed.status, 3);
    assert.deepEqual(calls().slice(1), [["--print", "First."]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function install(root, harness, prompts) {
  const shimRoot = join(root, "opt");
  const shimBin = join(root, "shim-bin");
  const realBin = join(root, "real-bin");
  const log = join(root, "calls.jsonl");
  for (const directory of [shimRoot, shimBin, realBin]) mkdirSync(directory);
  copyFileSync(new URL("./turns-shim.mjs", import.meta.url), join(shimRoot, "turns.mjs"));
  writeFileSync(join(shimRoot, "turns.json"), JSON.stringify({ prompts }));
  executable(
    join(shimBin, harness.cli),
    `#!/bin/sh\nexec node ${join(shimRoot, "turns.mjs")} "$0" "$@"\n`,
  );
  executable(
    join(realBin, harness.cli),
    `#!/usr/bin/env node\n` +
      `require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
      `console.log(${JSON.stringify(JSON.stringify(harness.event))});\n` +
      `process.exit(Number(process.env.FAKE_EXIT ?? 0));\n`,
  );
  return {
    run: (args, env = {}) =>
      spawnSync(harness.cli, args, {
        encoding: "utf8",
        env: { ...process.env, ...env, PATH: `${shimBin}:${realBin}:${process.env.PATH}` },
      }),
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

function executable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}
