import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { SandboxBackend, SandboxSession } from "eve/sandbox";
import { containerBackend } from "../../src/harnesses/e0/container-backend.ts";

const MAX_BYTES = 16 * 1024 * 1024;
const exec = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const node = (script: string) => `${quote(process.execPath)} -e ${quote(script)}`;

function env(t: TestContext, values: Record<string, string | undefined>) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const set = (entries: typeof values) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  set(values);
  t.after(() => set(previous));
}

async function fixture(t: TestContext, commandTimeoutMs = 3_000) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "eve-bench-e0-")));
  const root = join(dir, "task with 'quote");
  const backend: SandboxBackend = containerBackend(root, { commandTimeoutMs });
  const input = { sessionKey: `test:${root}`, templateKey: null, runtimeContext: { appRoot: dir } };
  const handle = await backend.create(input);
  t.after(async () => {
    await handle.shutdown();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, root, backend, handle, session: handle.session, input };
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function ready(root: string) {
  for (let i = 0; i < 100; i++) {
    try {
      return Number(await readFile(join(root, "descendant.pid"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  throw new Error("Descendant did not start");
}

async function stopped(pid: number) {
  for (let i = 0; i < 100; i++) {
    try {
      const { stdout } = await exec("ps", ["-o", "stat=", "-p", String(pid)]);
      // Linux init may reap a killed orphan later; a zombie cannot execute work.
      if (stdout.trim().startsWith("Z") || !stdout.trim()) return;
    } catch (error) {
      if ((error as { code?: number }).code === 1) return;
      throw error;
    }
    await delay(10);
  }
  assert.fail(`Process ${pid} is still running`);
}

const descendant = "(sleep 0.5; printf leaked > escaped) & echo $! > descendant.pid; wait";

test("default root requires workdir and container guard; explicit roots support local tests", async (t) => {
  const { root } = await fixture(t);
  env(t, { EVE_BENCH_TASK_WORKDIR: undefined, EVE_BENCH_CONTAINER: "1" });
  assert.throws(() => containerBackend(), /EVE_BENCH_TASK_WORKDIR/);
  process.env.EVE_BENCH_TASK_WORKDIR = root;
  delete process.env.EVE_BENCH_CONTAINER;
  assert.throws(() => containerBackend(), /EVE_BENCH_CONTAINER=1/);
  assert.throws(() => containerBackend(undefined, {}), /EVE_BENCH_CONTAINER=1/);
  assert.doesNotThrow(() => containerBackend(root));
  process.env.EVE_BENCH_CONTAINER = "1";
  assert.doesNotThrow(() => containerBackend());
  for (const invalid of ["", "relative"])
    assert.throws(() => containerBackend(invalid), /absolute task directory/);
  for (const commandTimeoutMs of [0, -1, NaN, Infinity, 2_147_483_648])
    assert.throws(() => containerBackend(root, { commandTimeoutMs }), /commandTimeoutMs/);
});

test("workspace paths, cwd, actual roots and skill home work without symlinks or shell rewriting", async (t) => {
  const { session, backend, dir, root } = await fixture(t);
  const home = join(dir, "home");
  env(t, { HOME: home });
  await mkdir(home);
  const prewarm = {
    templateKey: "test",
    runtimeContext: { appRoot: dir },
    seedFiles: [
      { path: "/workspace/nested/seed.txt", content: "seed\n" },
      { path: "$HOME/.agents/skills/test/SKILL.md", content: "skill\n" },
      { path: join(home, ".agents/skills/test/reference.md"), content: Buffer.from("reference\n") },
    ],
  };
  assert.deepEqual(await backend.prewarm(prewarm), { reused: false });
  assert.equal(session.resolvePath("/workspace"), root);
  assert.equal(session.resolvePath("/workspace/nested"), join(root, "nested"));
  assert.equal(session.resolvePath("nested/seed.txt"), join(root, "nested/seed.txt"));
  for (const escaped of [
    "/workspace-other",
    "/proc/self/environ",
    "/installed-agent",
    "../../outside",
  ]) {
    assert.throws(() => session.resolvePath(escaped), /must stay inside/);
    await assert.rejects(session.readTextFile({ path: escaped }), /must stay inside/);
  }
  assert.equal(await session.readTextFile({ path: "/workspace/nested/seed.txt" }), "seed\n");
  await symlink("/proc", join(root, "proc-link"));
  await assert.rejects(
    session.readTextFile({ path: "/workspace/proc-link/self/environ" }),
    /do not follow symbolic links/,
  );
  await rm(join(root, "proc-link"));
  assert.equal(
    await session.readTextFile({ path: "$HOME/.agents/skills/test/SKILL.md" }),
    "skill\n",
  );
  const shell = await session.run({
    command: 'printf "%s\\n" "$PWD"; cat seed.txt; cat "$HOME/.agents/skills/test/reference.md"',
    workingDirectory: "/workspace/nested",
  });
  assert.equal(shell.exitCode, 0, shell.stderr);
  assert.equal(shell.stdout, `${root}/nested\nseed\nreference\n`);
  const literal = await session.run({ command: "printf '%s' '/workspace/literal'" });
  assert.equal(literal.stdout, "/workspace/literal");
  const description = (session as SandboxSession & { description: string }).description;
  assert.ok(description.includes(JSON.stringify(root)));
  assert.match(description, /shell command text does not/);
  assert.equal((await lstat(root)).isSymbolicLink(), false);
  assert.deepEqual(await readdir(root), ["nested"]);
  await assert.rejects(
    backend.prewarm({ ...prewarm, bootstrap: () => assert.fail("must not bootstrap") }),
    /Production sandbox bootstrap/,
  );
  await assert.rejects(
    backend.prewarm({ ...prewarm, seedFiles: [{ path: join(dir, "unexpected"), content: "no" }] }),
    /must stay inside/,
  );
});

test("shell inherits only operational env, not provider/production secrets or startup hooks", async (t) => {
  const { session, dir } = await fixture(t);
  const startup = join(dir, "startup.sh");
  await writeFile(startup, "export INJECTED_SECRET=should-not-run\n");
  env(t, {
    AI_GATEWAY_API_KEY: "fake-provider",
    OPENAI_API_KEY: "fake-openai",
    ANTHROPIC_API_KEY: "fake-anthropic",
    D0_JUDGE_API_KEY: "fake-judge",
    VERCEL_TOKEN: "fake-vercel",
    AWS_SECRET_ACCESS_KEY: "fake-aws",
    DATABASE_URL: "fake-database",
    CUSTOM_PRODUCTION_VALUE: "fake-custom",
    GITHUB_TOKEN: "fake-github",
    BASH_ENV: startup,
    ENV: startup,
    NODE_OPTIONS: "--trace-warnings",
    LANG: "C",
  });
  const result = await session.run({
    command: node("console.log(JSON.stringify(process.env))"),
    env: { EVE_CODE_DIAGNOSTICS_REQUEST: "explicit-tool-data" },
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const forwarded = JSON.parse(result.stdout) as Record<string, string>;
  for (const key of [
    "AI_GATEWAY_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "D0_JUDGE_API_KEY",
    "VERCEL_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "DATABASE_URL",
    "CUSTOM_PRODUCTION_VALUE",
    "GITHUB_TOKEN",
    "BASH_ENV",
    "ENV",
    "NODE_OPTIONS",
    "INJECTED_SECRET",
  ])
    assert.equal(forwarded[key], undefined, key);
  assert.equal(forwarded.PATH, process.env.PATH);
  assert.equal(forwarded.LANG, "C");
  assert.equal(forwarded.EVE_CODE_DIAGNOSTICS_REQUEST, "explicit-tool-data");
  const override = await session.run({ command: 'printf "%s" "$LANG"', env: { LANG: "explicit" } });
  assert.equal(override.stdout, "explicit");
});

test("binary, text and streaming file operations preserve bytes, ranges, encodings and removal", async (t) => {
  const { session } = await fixture(t);
  for (const method of ["readFile", "readBinaryFile", "readTextFile"] as const)
    assert.equal(await session[method]({ path: "missing" }), null);
  await session.writeTextFile({ path: "/workspace/text", content: "one\n😀two\nthree\n" });
  assert.equal(await session.readTextFile({ path: "text", startLine: 2, endLine: 2 }), "😀two");
  assert.equal(await session.readTextFile({ path: "text", startLine: 3, endLine: 99 }), "three\n");
  await assert.rejects(
    async () => session.readTextFile({ path: "text", startLine: 0 }),
    /line range/,
  );
  await assert.rejects(
    async () => session.readTextFile({ path: "text", startLine: 3, endLine: 2 }),
    /line range/,
  );
  await session.writeTextFile({ path: "latin", content: "café", encoding: "latin1" });
  assert.equal(await session.readTextFile({ path: "latin", encoding: "latin1" }), "café");
  await assert.rejects(async () => session.readTextFile({ path: "latin" }), /encoded data/);
  const bytes = Uint8Array.from([0, 255, 128, 1]);
  await session.writeBinaryFile({ path: "binary", content: bytes });
  assert.deepEqual(
    Buffer.from((await session.readBinaryFile({ path: "binary" }))!),
    Buffer.from(bytes),
  );
  const stream = await session.readFile({ path: "text" });
  assert.ok(stream);
  await session.writeFile({ path: "copy/nested", content: stream });
  assert.equal(await session.readTextFile({ path: "copy/nested" }), "one\n😀two\nthree\n");
  await session.removePath({ path: "/workspace/copy", recursive: true });
  await session.removePath({ path: "missing", force: true });
  assert.equal(await session.readFile({ path: "copy/nested" }), null);
});

test("all file surfaces are bounded and oversized streamed writes leave existing files untouched", async (t) => {
  const { session, root } = await fixture(t);
  const file = await open(join(root, "large"), "w");
  await file.truncate(MAX_BYTES + 1);
  await file.close();
  for (const method of ["readFile", "readBinaryFile", "readTextFile"] as const)
    await assert.rejects(
      async () => session[method]({ path: "large" }),
      /File read exceeds 16 MiB/,
    );
  await assert.rejects(async () => session.readBinaryFile({ path: "." }), /regular files/);
  await session.writeTextFile({ path: "target", content: "unchanged" });
  await assert.rejects(
    async () => session.writeBinaryFile({ path: "target", content: new Uint8Array(MAX_BYTES + 1) }),
    /File write exceeds 16 MiB/,
  );
  await assert.rejects(
    async () => session.writeTextFile({ path: "target", content: "😀".repeat(MAX_BYTES / 4 + 1) }),
    /File write exceeds 16 MiB/,
  );
  let cancelled = false;
  const content = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    async () => session.writeFile({ path: "target", content }),
    /File write exceeds 16 MiB/,
  );
  assert.equal(cancelled, true);
  assert.equal(await session.readTextFile({ path: "target" }), "unchanged");
  await session.writeBinaryFile({ path: "boundary", content: new Uint8Array(MAX_BYTES) });
  assert.equal((await session.readBinaryFile({ path: "boundary" }))?.byteLength, MAX_BYTES);
  assert.equal((await session.run({ command: "mkfifo pipe" })).exitCode, 0);
  await assert.rejects(async () => session.readBinaryFile({ path: "pipe" }), /regular files/);
  await assert.rejects(
    async () => session.writeTextFile({ path: "pipe", content: "no" }),
    /ENXIO|regular files/,
  );
  await assert.rejects(
    async () => session.writeTextFile({ path: "/dev/null", content: "no" }),
    /must stay inside/,
  );
});

test("aborted file operations and a blocked stream reject without writing", async (t) => {
  const { session } = await fixture(t);
  const controller = new AbortController();
  const reason = new Error("cancel file");
  const content = new ReadableStream<Uint8Array>();
  const pending = session.writeFile({ path: "never", content, abortSignal: controller.signal });
  controller.abort(reason);
  await assert.rejects(
    async () => pending,
    (error) => error === reason,
  );
  await assert.rejects(
    async () => session.readFile({ path: "never", abortSignal: controller.signal }),
    (error) => error === reason,
  );
  await assert.rejects(
    async () =>
      session.writeBinaryFile({
        path: "never",
        content: new Uint8Array(),
        abortSignal: controller.signal,
      }),
    (error) => error === reason,
  );
  await assert.rejects(
    session.removePath({ path: "never", abortSignal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(await session.readFile({ path: "never" }), null);
});

test("run and spawn preserve split UTF-8, stderr and native nonzero exits", async (t) => {
  const { session } = await fixture(t);
  const command = node(
    "process.stdout.write(Buffer.from([0xf0, 0x9f])); setTimeout(() => { process.stdout.write(Buffer.from([0x98, 0x80])); process.stderr.write('err'); process.exitCode = 7; }, 20)",
  );
  assert.deepEqual(await session.run({ command }), { stdout: "😀", stderr: "err", exitCode: 7 });
  const child = await session.spawn({ command });
  const [stdout, stderr, result] = await Promise.all([
    collect(child.stdout),
    collect(child.stderr),
    child.wait(),
  ]);
  assert.deepEqual({ stdout, stderr, ...result }, { stdout: "😀", stderr: "err", exitCode: 7 });
  await child.kill();
  await child.kill();
  await assert.rejects(
    async () => session.run({ command: "true", workingDirectory: "absent" }),
    /ENOENT/,
  );
});

for (const method of ["run", "spawn"] as const) {
  test(`${method} timeout kills the entire process group`, async (t) => {
    const { session, root } = await fixture(t, 200);
    const operation = session[method]({ command: descendant });
    const pid = await ready(root);
    if (method === "run") {
      const result = (await operation) as Awaited<ReturnType<SandboxSession["run"]>>;
      assert.equal(result.exitCode, 124);
      assert.match(result.stderr, /process group was stopped/);
    } else {
      const child = (await operation) as Awaited<ReturnType<SandboxSession["spawn"]>>;
      assert.equal((await child.wait()).exitCode, 124);
    }
    await stopped(pid);
    await delay(550);
    assert.equal(await session.readFile({ path: "escaped" }), null);
  });
  test(`${method} abort kills descendants and rejects with the abort reason`, async (t) => {
    const { session, root } = await fixture(t);
    const controller = new AbortController();
    const reason = new Error("cancel command");
    const operation = session[method]({ command: descendant, abortSignal: controller.signal });
    const completion =
      method === "run"
        ? operation
        : Promise.resolve(operation).then((child) =>
            (child as Awaited<ReturnType<SandboxSession["spawn"]>>).wait(),
          );
    const rejection = assert.rejects(
      async () => completion,
      (error) => error === reason,
    );
    const pid = await ready(root);
    controller.abort(reason);
    await rejection;
    await stopped(pid);
    await assert.rejects(
      async () => session[method]({ command: "touch never", abortSignal: controller.signal }),
      (error) => error === reason,
    );
    assert.equal(await session.readFile({ path: "never" }), null);
  });
  test(`${method} bounds combined stdout/stderr even when spawn output is not consumed`, async (t) => {
    const { session } = await fixture(t);
    const command = node(
      "const chunk = Buffer.alloc(1024 * 1024, 'x'); setInterval(() => { process.stdout.write(chunk); process.stderr.write(chunk); }, 1)",
    );
    if (method === "run")
      await assert.rejects(async () => session.run({ command }), /Command output exceeds 16 MiB/);
    else {
      const child = await session.spawn({ command });
      await assert.rejects(async () => child.wait(), /Command output exceeds 16 MiB/);
      await stopped(child.pid!);
    }
  });
}

test("stop/shutdown are idempotent, retain task files and allow reattachment; shell exit kills background work", async (t) => {
  const { session, backend, handle, input, root } = await fixture(t);
  await session.writeTextFile({ path: "keep", content: "task artifact" });
  for (const stop of [handle.stop, handle.shutdown]) {
    const child = await session.spawn({ command: descendant });
    const pid = await ready(root);
    await stop();
    await stop();
    await stopped(pid);
    assert.equal((await child.wait()).exitCode, 137);
    await session.removePath({ path: "descendant.pid" });
  }
  assert.deepEqual(await handle.captureState(), {
    backendName: backend.name,
    metadata: {},
    sessionKey: input.sessionKey,
  });
  const reopened = await backend.create(input);
  assert.equal(reopened.session.id, session.id);
  assert.equal((await reopened.useSessionFn()).id, session.id);
  assert.equal(await reopened.session.readTextFile({ path: "keep" }), "task artifact");
  await session.run({
    command: "(sleep 0.5; printf leaked > escaped) >/dev/null 2>&1 & echo $! > descendant.pid",
  });
  await stopped(await ready(root));
  await session.setNetworkPolicy("allow-all");
  await assert.rejects(session.setNetworkPolicy("deny-all"), /runner owns network policy/);
});

test("installed eve built-in bash/file tools work with workspace, actual root and home paths", async (t) => {
  const { session, dir, root } = await fixture(t);
  env(t, { HOME: join(dir, "home") });
  const installed = new URL("../../node_modules/eve/dist/src/", import.meta.url);
  const { ContextContainer, contextStorage } = await import(
    new URL("context/container.js", installed).href
  );
  const { executeBashOnSandbox } = await import(
    new URL("execution/sandbox/bash-tool.js", installed).href
  );
  const { executeReadFileOnSandbox } = await import(
    new URL("execution/sandbox/read-file-tool.js", installed).href
  );
  const { executeWriteFileOnSandbox } = await import(
    new URL("execution/sandbox/write-file-tool.js", installed).href
  );
  const { executeGlobOnSandbox } = await import(
    new URL("execution/sandbox/glob-tool.js", installed).href
  );
  const { executeGrepOnSandbox } = await import(
    new URL("execution/sandbox/grep-tool.js", installed).href
  );
  await contextStorage.run(new ContextContainer(), async () => {
    for (const filePath of ["/workspace/builtin.txt", "$HOME/.agents/skills/example/SKILL.md"]) {
      assert.equal(
        (await executeWriteFileOnSandbox(session, { filePath, content: "first\n" })).existed,
        false,
      );
      assert.equal((await executeReadFileOnSandbox(session, { filePath })).content, "1: first");
      assert.equal(
        (await executeWriteFileOnSandbox(session, { filePath, content: "second\n" })).existed,
        true,
      );
    }
    const result = await executeBashOnSandbox(session, { command: "cat builtin.txt" });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "second\n");
    const glob = await executeGlobOnSandbox(session, { path: root, pattern: "*.txt" });
    assert.equal(glob.count, 1);
    assert.equal(glob.content, join(root, "builtin.txt"));
    const grep = await executeGrepOnSandbox(session, { path: root, pattern: "second" });
    assert.equal(grep.matchCount, 1);
    assert.ok(grep.content.includes("builtin.txt:1:second"));
  });
});

// Optional real extension check: supply the eve-code package path from the e0
// source checkout. Run on Linux (GNU realpath/stat), with no model or network.
test(
  "real e0 code__apply_patch adds, updates, moves and deletes files in the actual task root",
  {
    skip: !process.env.EVE_BENCH_EVE_CODE_DIR
      ? "Set EVE_BENCH_EVE_CODE_DIR to the eve-code package"
      : false,
  },
  async (t) => {
    const { session, root } = await fixture(t);
    const { default: tool } = await import(
      pathToFileURL(join(process.env.EVE_BENCH_EVE_CODE_DIR!, "extension/tools/apply_patch.ts"))
        .href
    );
    const initialized = await session.run({ command: "git init -q" });
    assert.equal(initialized.exitCode, 0, initialized.stderr);
    const ctx = { getSandbox: async () => session };
    const added = await tool.execute(
      { root, patchText: "*** Begin Patch\n*** Add File: hello.txt\n+before\n*** End Patch" },
      ctx,
    );
    assert.equal(added.files[0].operation, "add");
    assert.deepEqual(added.diagnostics, []);
    const updated = await tool.execute(
      {
        root,
        patchText:
          "*** Begin Patch\n*** Update File: hello.txt\n@@\n-before\n+after\n*** End Patch",
      },
      ctx,
    );
    assert.equal(updated.files[0].operation, "update");
    const moved = await tool.execute(
      {
        root,
        patchText:
          "*** Begin Patch\n*** Update File: hello.txt\n*** Move to: nested/moved.txt\n*** End Patch",
      },
      ctx,
    );
    assert.equal(moved.files[0].operation, "move");
    assert.equal(await session.readTextFile({ path: "/workspace/nested/moved.txt" }), "after\n");
    assert.equal(await session.readTextFile({ path: "hello.txt" }), null);
    const deleted = await tool.execute(
      { root, patchText: "*** Begin Patch\n*** Delete File: nested/moved.txt\n*** End Patch" },
      ctx,
    );
    assert.equal(deleted.files[0].operation, "delete");
    assert.equal(await session.readTextFile({ path: "nested/moved.txt" }), null);
    await assert.rejects(
      tool.execute(
        { root, patchText: "*** Begin Patch\n*** Add File: ../escape\n+no\n*** End Patch" },
        ctx,
      ),
      /invalid patch path/,
    );
  },
);
