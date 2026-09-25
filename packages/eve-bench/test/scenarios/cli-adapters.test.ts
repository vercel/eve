import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createCliHarness } from "../../src/harnesses/cli/index.ts";
import { shellQuote, type SupportedCliName } from "../../src/harnesses/cli/plan.ts";
import type { Harness, HarnessBundle, HarnessRunContext } from "../../src/core/harness.ts";

const exec = promisify(execFile);
const sourceDir = fileURLToPath(new URL("../../src/harnesses/cli/", import.meta.url));
const FAKE_KEY = 'model-free-fake-key-"abcdef';
const TASK_HOME = "/task-home";

async function temp(t: TestContext): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "eve-bench-cli-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const mockCli = `import { readFile } from 'node:fs/promises';
const args = process.argv.slice(2);
if (args[0] === '--version') {
  if (process.env.AI_GATEWAY_API_KEY || process.env.OPENAI_API_KEY) process.exit(92);
  console.log('mock-cli 1.2.3');
} else {
  const name = JSON.parse(await readFile(new URL('./identity.json', import.meta.url), 'utf8')).name;
  const path = name === 'pi' ? process.env.PI_CODING_AGENT_DIR + '/models.json'
    : name === 'codex' ? process.env.CODEX_HOME + '/config.toml'
    : process.env.OPENCODE_CONFIG;
  const config = await readFile(path, 'utf8');
  let input = '';
  for await (const chunk of process.stdin) input += chunk.toString();
  const prompt = name === 'pi' ? input : args.at(-1);
  if (name === 'pi' && args.includes('--')) throw new Error('pi does not support a -- separator');
  console.log(JSON.stringify({ type: 'mock', args, prompt, cwd: process.cwd(), config,
    env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, CODEX_HOME: process.env.CODEX_HOME,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL, OPENCODE_FAKE_VCS: process.env.OPENCODE_FAKE_VCS,
      HOME: process.env.HOME, PATH: process.env.PATH, TASK_IMAGE_ENV: process.env.TASK_IMAGE_ENV,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME, runnerContext: process.env.EVE_BENCH_CLI_CONTEXT },
    credentialMapped: process.env.AI_GATEWAY_API_KEY === ${JSON.stringify(FAKE_KEY)} && process.env.OPENAI_API_KEY === process.env.AI_GATEWAY_API_KEY }));
  const key = process.env.AI_GATEWAY_API_KEY;
  process.stdout.write(key.slice(0, 12));
  await new Promise(r => setTimeout(r, 10));
  process.stdout.write(key.slice(12) + '\\n');
  process.stderr.write(JSON.stringify(key) + '\\n');
  if (prompt === '__opencode_error__') process.stdout.write(JSON.stringify({ type: 'error', error: 'mock failure' }));
  if (prompt === '__exit_7__') process.exitCode = 7;
  if (prompt === '__signal__') process.kill(process.pid, 'SIGTERM');
}
`;

async function mockInstalled(t: TestContext, name: SupportedCliName) {
  const root = await temp(t);
  const installDir = join(root, "install with 'quote");
  await mkdir(join(installDir, "arch"), { recursive: true });
  for (const file of ["runner.ts", "plan.ts", "output.ts"])
    await cp(join(sourceDir, file), join(installDir, file));
  await writeFile(
    join(installDir, "arch/node"),
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`,
    { mode: 0o755 },
  );
  await writeFile(join(installDir, "arch/mock.mjs"), mockCli);
  await writeFile(join(installDir, "arch/identity.json"), JSON.stringify({ name }));
  await writeFile(join(installDir, "arch/entry.json"), JSON.stringify({ entry: "mock.mjs" }));
  const ctx = {
    model: "deepseek/deepseek-v4",
    installDir,
    instructionPath: join(root, "instruction with 'quote.md"),
    taskWorkdir: join(root, "task with space"),
    logsDir: join(root, "logs"),
  };
  await mkdir(ctx.taskWorkdir);
  return { root, ctx, harness: createCliHarness(name, { version: "1.2.3", reasoning: "high" }) };
}

async function invoke(
  harness: Harness,
  ctx: HarnessRunContext,
  instruction: string,
  key: string | undefined = FAKE_KEY,
) {
  await writeFile(ctx.instructionPath, instruction);
  try {
    const result = await exec("sh", ["-c", harness.command(ctx)], {
      env: {
        PATH: process.env.PATH,
        HOME: TASK_HOME,
        TASK_IMAGE_ENV: "from-image",
        AI_GATEWAY_API_KEY: key,
        ...harness.env(ctx),
      },
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, ...result };
  } catch (error) {
    const failed = error as Error & { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

for (const name of ["pi", "opencode", "codex"] as const) {
  for (const model of ["deepseek/deepseek-v4", "openai/gpt-5.6"]) {
    test(`${name} mock binary receives native flags, full ${model}, safe config and runtime credentials`, async (t) => {
      const { ctx, harness } = await mockInstalled(t, name);
      ctx.model = model;
      const prompt = "--untrusted 'quote'\n$(touch SHOULD_NOT_EXIST)";
      const result = await invoke(harness, ctx, prompt);
      assert.equal(result.code, 0, result.stderr);
      const log = await readFile(join(ctx.logsDir, `${name}.jsonl`), "utf8");
      const record = JSON.parse(log.split("\n")[0]!);
      assert.equal(record.cwd, ctx.taskWorkdir);
      assert.equal(record.prompt, prompt);
      assert.equal(record.credentialMapped, true);
      // Task-side state must stay where the verifier will look for it.
      assert.equal(record.env.HOME, TASK_HOME);
      assert.equal(record.env.PATH, process.env.PATH);
      assert.equal(record.env.TASK_IMAGE_ENV, "from-image");
      assert.equal(record.env.XDG_DATA_HOME, undefined);
      assert.equal(record.env.runnerContext, undefined);
      assert.ok(
        record.args.includes(model) || record.args.includes(`--model=eve-bench-gateway/${model}`),
      );
      assert.match(record.config, /ai-gateway.vercel.sh/);
      if (name === "pi") {
        assert.equal(JSON.parse(record.config).providers["eve-bench-gateway"].models[0].id, model);
        assert.match(record.config, /\$AI_GATEWAY_API_KEY/);
      } else if (name === "opencode") {
        assert.ok(JSON.parse(record.config).provider["eve-bench-gateway"].models[model]);
        assert.equal(record.env.OPENCODE_FAKE_VCS, "git");
      } else {
        assert.match(record.config, /wire_api = "responses"/);
        assert.match(record.config, /env_key = "AI_GATEWAY_API_KEY"/);
      }
      for (const file of await readdir(ctx.logsDir)) {
        const content = await readFile(join(ctx.logsDir, file), "utf8");
        assert.ok(!content.includes(FAKE_KEY));
        assert.ok(!content.includes(JSON.stringify(FAKE_KEY).slice(1, -1)));
      }
      assert.ok(!result.stdout.includes(FAKE_KEY));
      assert.ok(!result.stderr.includes(FAKE_KEY));
      assert.match(log, /\[REDACTED\]/);
      assert.deepEqual(await readdir(ctx.taskWorkdir), []);
      assert.ok(!(await readdir(ctx.installDir)).some((file) => file.startsWith(".cli-runtime-")));
      const metrics = JSON.parse(await readFile(join(ctx.logsDir, "cli-runtime.json"), "utf8"));
      assert.equal(metrics.installLocation, "host");
      assert.equal(metrics.containerInstallMs, 0);
      assert.ok(metrics.setupMs >= 0);
      assert.ok(metrics.agentMs > 0);
      assert.equal(metrics.exitCode, 0);
    });
  }
}

test("native nonzero exits, signals, and OpenCode zero-exit error events fail the harness", async (t) => {
  for (const [name, instruction, expected] of [
    ["pi", "__exit_7__", 7],
    ["codex", "__signal__", 1],
    ["opencode", "__opencode_error__", 1],
  ] as const) {
    const { ctx, harness } = await mockInstalled(t, name);
    const result = await invoke(harness, ctx, instruction);
    assert.equal(result.code, expected);
    const metrics = JSON.parse(await readFile(join(ctx.logsDir, "cli-runtime.json"), "utf8"));
    assert.equal(metrics.exitCode, expected);
    if (instruction === "__signal__") assert.equal(metrics.signal, "SIGTERM");
    if (instruction === "__opencode_error__") assert.match(metrics.failure, /error event/);
  }
});

test("missing key, oversized prompt, and version mismatch fail before the agent starts", async (t) => {
  const { ctx, harness } = await mockInstalled(t, "pi");
  const missing = await invoke(harness, ctx, "do not run", "");
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /AI_GATEWAY_API_KEY must be forwarded/);
  assert.deepEqual(await readdir(ctx.logsDir), ["cli-runtime.json"]);
  const oversized = await invoke(harness, ctx, "x".repeat(1024 * 1024 + 1));
  assert.equal(oversized.code, 1);
  assert.match(oversized.stderr, /exceeds 1 MiB/);
  const wrong = await invoke(createCliHarness("pi", { version: "1.2.30" }), ctx, "do not run");
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /failed its --version check/);
  const metrics = JSON.parse(await readFile(join(ctx.logsDir, "cli-runtime.json"), "utf8"));
  assert.equal(metrics.agentMs, 0);
});

test("host prepare uses pinned pnpm installs, verifies archives, caches across models, and relocates", async (t) => {
  const root = await temp(t);
  const bin = join(root, "bin");
  await mkdir(bin);
  const calls = join(root, "pnpm-calls.jsonl");
  const shebang = `#!${process.execPath}\n`;
  await writeFile(
    join(bin, "pnpm"),
    shebang +
      `
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (process.env.AI_GATEWAY_API_KEY || process.env.OPENAI_API_KEY || process.env.UNRELATED_TEST_API_KEY) process.exit(91);
if (args[0] === '--version') { console.log('11.21.0'); }
else {
  await appendFile(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const [pkg, version] = Object.entries(manifest.dependencies)[0];
  const dir = join(process.cwd(), 'node_modules', pkg);
  const name = pkg.includes('pi-coding-agent') ? 'pi' : pkg === 'opencode-ai' ? 'opencode' : 'codex';
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ version, bin: { [name]: 'cli.mjs' } }));
  await writeFile(join(dir, 'cli.mjs'), ${JSON.stringify(mockCli)});
  await writeFile(join(dir, 'identity.json'), JSON.stringify({ name }));
  await writeFile('pnpm-lock.yaml', 'lockfileVersion: 9.0\\n');
}
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "tar"),
    shebang +
      `
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const args = process.argv.slice(2);
await writeFile(join(args[args.indexOf('-C') + 1], 'node'), ${JSON.stringify(`#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`)});
`,
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  const originalKey = process.env.AI_GATEWAY_API_KEY;
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.AI_GATEWAY_API_KEY = FAKE_KEY;
  t.after(() => {
    process.env.PATH = originalPath;
    if (originalKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = originalKey;
  });
  const archive = Buffer.from("mock node archive");
  const hash = createHash("sha256").update(archive).digest("hex");
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    fetches++;
    assert.match(url, /^https:\/\/nodejs.org\/dist\/v24\.19\.0\//);
    return new Response(
      url.endsWith("SHASUMS256.txt")
        ? `${hash}  node-v24.19.0-linux-x64.tar.xz\n${hash}  node-v24.19.0-linux-arm64.tar.xz\n`
        : archive,
    );
  });
  const harness = createCliHarness("pi", { version: "1.2.3" });
  const cacheDir = join(root, "cache");
  const bundle = await harness.prepare({ model: "deepseek/deepseek-v4", cacheDir });
  assert.equal(fetches, 4);
  const sameBundle = await harness.prepare({ model: "openai/gpt-5.6", cacheDir });
  assert.equal(sameBundle.dir, bundle.dir);
  assert.equal(bundle.provenance?.model, "deepseek/deepseek-v4");
  assert.equal(sameBundle.provenance?.model, "openai/gpt-5.6");
  const differentConfig = await createCliHarness("pi", {
    version: "1.2.3",
    reasoning: "high",
    baseUrl: "https://gateway.example.test/v1",
  }).prepare({ model: "openai/gpt-5.6", cacheDir });
  assert.equal(differentConfig.dir, bundle.dir);
  assert.equal(differentConfig.provenance?.reasoning, "high");
  assert.equal(differentConfig.provenance?.baseUrl, "https://gateway.example.test/v1");
  assert.equal(fetches, 4);
  const installs = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(installs.length, 2);
  for (const [i, args] of installs.entries()) {
    assert.ok(args.includes("--ignore-scripts"));
    assert.ok(args.includes("--ignore-workspace"));
    assert.ok(args.includes("--os=linux"));
    assert.ok(args.includes(`--cpu=${i === 0 ? "x64" : "arm64"}`));
    assert.ok(!args.some((arg) => arg.includes("latest")));
  }
  assert.equal(bundle.provenance?.installLocation, "host");
  assert.equal(bundle.provenance?.version, "1.2.3");
  assert.equal(bundle.provenance?.containerInstallMs, 0);
  assert.match(JSON.stringify(bundle.provenance?.lockSha256), /[a-f0-9]{64}/);
  assert.ok(!JSON.stringify(bundle.provenance).includes(FAKE_KEY));
  for (const arch of ["x64", "arm64"] as const) await assertRelocated(bundle, harness, root, arch);

  // A failed build must not publish a cache entry or retain partial build trees.
  t.mock.method(globalThis, "fetch", async () => new Response("bad checksum"));
  await assert.rejects(
    createCliHarness("codex", { version: "1.2.3" }).prepare({ model: "openai/gpt-5.6", cacheDir }),
    /checksum is missing/,
  );
  assert.ok(!(await readdir(join(cacheDir, "cli"))).some((name) => name.startsWith(".prepare-")));
});

async function assertRelocated(
  bundle: HarnessBundle,
  harness: Harness,
  root: string,
  arch: "x64" | "arm64",
) {
  const installDir = join(root, `relocated ${arch}`);
  await cp(bundle.dir, installDir, { recursive: true });
  await cp(bundle.arch![arch], join(installDir, "arch"), { recursive: true });
  const ctx = {
    model: "openai/gpt-5.6",
    installDir,
    taskWorkdir: root,
    instructionPath: join(root, `${arch}-instruction.md`),
    logsDir: join(root, `${arch}-logs`),
  };
  const result = await invoke(harness, ctx, "mock relocation");
  assert.equal(result.code, 0, result.stderr);
  assert.match(await readFile(join(ctx.logsDir, "pi.jsonl"), "utf8"), /mock relocation/);
  assert.equal(dirname(bundle.dir), dirname(bundle.arch![arch]));
}
