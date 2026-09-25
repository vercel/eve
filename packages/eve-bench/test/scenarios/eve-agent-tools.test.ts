import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import bash from "../../agent/tools/bash.ts";
import grep from "../../agent/tools/grep.ts";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

type Executable = {
  execute: (input: never, ctx: { abortSignal: AbortSignal }) => Promise<unknown>;
};

function run(
  tool: unknown,
  input: Record<string, unknown>,
  signal = new AbortController().signal,
): Promise<CommandResult> {
  return (tool as Executable).execute(input as never, {
    abortSignal: signal,
  }) as Promise<CommandResult>;
}

/** Points the tools at a fresh task directory and restores the process env afterwards. */
async function taskEnvironment(t: TestContext, env: Record<string, string> = {}): Promise<string> {
  const workdir = await realpath(await mkdtemp(join(tmpdir(), "eve-bench-tools-")));
  const saved = { ...process.env };
  Object.assign(process.env, { EVE_BENCH_TASK_WORKDIR: workdir, ...env });
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(workdir, { recursive: true, force: true });
  });
  return workdir;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("bash runs in the task directory and passes exit codes and streams through", async (t) => {
  const workdir = await taskEnvironment(t);
  assert.deepEqual(await run(bash, { command: "pwd; echo err >&2; exit 7" }), {
    exitCode: 7,
    stdout: `${workdir}\n`,
    stderr: "err\n",
  });
});

test("bash commands see the task's own PORT and HOST, not the eve server's", async (t) => {
  // The runner overrides these for the server and records the container's values.
  await taskEnvironment(t, {
    PORT: "3024",
    HOST: "127.0.0.1",
    NITRO_PORT: "3024",
    EVE_BENCH_TASK_ENV_RESTORE: JSON.stringify({ PORT: null, HOST: "task-host", NITRO_PORT: null }),
  });
  const result = await run(bash, {
    command:
      'echo "PORT=${PORT-unset} HOST=$HOST NITRO_PORT=${NITRO_PORT-unset} RESTORE=${EVE_BENCH_TASK_ENV_RESTORE-unset}"',
  });
  assert.equal(result.stdout, "PORT=unset HOST=task-host NITRO_PORT=unset RESTORE=unset\n");
});

test("bash timeout returns 124 with partial output and kills the whole process group", async (t) => {
  await taskEnvironment(t);
  const started = Date.now();
  const result = await run(bash, {
    command: "sleep 30 & echo child=$!; sleep 30",
    timeoutSeconds: 1,
  });
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started}ms`);
  assert.equal(result.exitCode, 124);
  assert.match(result.stderr, /stopped after 1 seconds/);
  const child = Number(/child=(\d+)/.exec(result.stdout)?.[1]);
  assert.ok(child > 0, result.stdout);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(alive(child), false, "background child survived the timeout");
});

test("bash returns when the shell exits even if a background job holds the output pipe", async (t) => {
  await taskEnvironment(t);
  const started = Date.now();
  const result = await run(bash, { command: "sleep 5 & echo started" });
  assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started}ms`);
  assert.deepEqual(result, { exitCode: 0, stdout: "started\n", stderr: "" });
});

test("bash abort stops the command", async (t) => {
  await taskEnvironment(t);
  const controller = new AbortController();
  const started = Date.now();
  const pending = run(bash, { command: "sleep 30" }, controller.signal);
  setTimeout(() => controller.abort(), 100);
  const result = await pending;
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started}ms`);
  assert.notEqual(result.exitCode, 0);
});

test("grep reports a missing ripgrep instead of returning no matches", async (t) => {
  await taskEnvironment(t, { PATH: "/nonexistent" });
  await assert.rejects(run(grep, { pattern: "needle" }), /ripgrep \(rg\) is not installed/);
});

let hasRipgrep = true;
try {
  execFileSync("rg", ["--version"], { stdio: "ignore" });
} catch {
  hasRipgrep = false;
}

test(
  "grep distinguishes matches from no matches",
  { skip: !hasRipgrep && "rg not installed" },
  async (t) => {
    const workdir = await taskEnvironment(t);
    await writeFile(join(workdir, "notes.txt"), "alpha\nneedle here\n");
    const found = await run(grep, { pattern: "needle" });
    assert.equal(found.exitCode, 0);
    assert.match(found.stdout, /notes\.txt:2:needle here/);
    assert.deepEqual(await run(grep, { pattern: "absent" }), {
      exitCode: 1,
      stderr: "",
      stdout: "",
    });
  },
);
