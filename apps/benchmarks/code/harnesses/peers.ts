import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { HarnessBundle, HarnessName, HarnessRunContext, ReasoningLevel } from "../types.ts";
import { ensureNodeRuntime, LINUX_ARCHES, type LinuxArch } from "./node-runtime.ts";

const exec = promisify(execFile);

const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

export const PEER_VERSIONS = {
  pi: "1.7.0",
  opencode: "2.2.5",
  fx: "0.0.16",
} as const;

const OPENCODE_SHA256: Readonly<Record<LinuxArch, string>> = {
  x64: "92690eee07a680d3cb760ca02ba43878de9eab1b4e5d5dfae8795518c53628f4",
  arm64: "f8c5a82075fede9b5b044ed6c8a6d13ad807a7e62caea1cd0a878adef49eb053",
};

const FX_RELEASES: Readonly<
  Record<LinuxArch, { readonly target: string; readonly sha256: string }>
> = {
  x64: {
    target: "linux-x86_64",
    sha256: "f0fb822c7be546c80bcc89d50521bc1454435e0c6f586e8420c4e2b84fa80599",
  },
  arm64: {
    target: "linux-aarch64",
    sha256: "ca9441b104357e2105039dbfd4c2eaf0d6ee65a84085f23f51e880c95cbf46af",
  },
};

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadTo(url: string, dest: string, expectedSha256?: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  await writeFile(dest, Buffer.from(await response.arrayBuffer()));
  if (expectedSha256) {
    const actual = await fileSha256(dest);
    if (actual !== expectedSha256) {
      throw new Error(`Checksum mismatch for ${url}: expected ${expectedSha256}, got ${actual}`);
    }
  }
}

export async function preparePeerHarness(options: {
  readonly harness: Exclude<HarnessName, "eve-code">;
  readonly cacheDir: string;
  readonly model: string;
  readonly reasoning: ReasoningLevel;
}): Promise<HarnessBundle> {
  if (options.harness === "pi") return preparePi(options.cacheDir, options.reasoning);
  if (options.harness === "opencode") return prepareOpenCode(options.cacheDir, options.reasoning);
  return prepareFx(options.cacheDir, options.reasoning);
}

const PI_RUNNER_MJS = `import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const installDir = process.env.CODE_BENCH_INSTALL_DIR;
const instructionPath = process.env.CODE_BENCH_INSTRUCTION_PATH;
const logsDir = process.env.CODE_BENCH_LOGS_DIR;
const model = process.env.CODE_BENCH_MODEL;
const reasoning = process.env.CODE_BENCH_REASONING || "high";
const timeoutMs = Number(process.env.CODE_BENCH_TIMEOUT_MS) || 20 * 60 * 1000;
const apiKey = process.env.AI_GATEWAY_API_KEY;
if (!apiKey) throw new Error("AI_GATEWAY_API_KEY is required");

await mkdir(logsDir, { recursive: true });
const runtimeDir = await mkdtemp(join(installDir, ".pi-runtime-"));
const isAnthropic = model.startsWith("anthropic/");
const provider = isAnthropic
  ? {
      baseUrl: "${GATEWAY_BASE_URL.replace(/\/v1$/u, "")}",
      apiKey: "$AI_GATEWAY_API_KEY",
      api: "anthropic-messages",
      models: [
        {
          id: model,
          reasoning: reasoning !== "off",
          compat: { allowEmptySignature: true, forceAdaptiveThinking: true },
        },
      ],
    }
  : {
      baseUrl: "${GATEWAY_BASE_URL}",
      apiKey: "$AI_GATEWAY_API_KEY",
      api: "openai-completions",
      models: [{ id: model, reasoning: reasoning !== "off" }],
    };

await mkdir(join(runtimeDir, "pi"), { recursive: true });
await writeFile(
  join(runtimeDir, "pi/models.json"),
  JSON.stringify({ providers: { "code-bench-gateway": provider } }, null, 2) + "\\n",
  { mode: 0o600 },
);

const instruction = await readFile(instructionPath, "utf8");
const outPath = join(logsDir, "pi.jsonl");
const outStream = createWriteStream(outPath);
const startedAt = Date.now();
const piBin = join(installDir, "pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

const child = spawn(
  join(installDir, "arch/node"),
  [
    piBin,
    "--print",
    "--mode",
    "json",
    "--session-dir",
    join(runtimeDir, "pi/sessions"),
    "--provider",
    "code-bench-gateway",
    "--model",
    model,
    "--thinking",
    reasoning,
  ],
  {
    env: { ...process.env, PI_CODING_AGENT_DIR: join(runtimeDir, "pi") },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
child.stdout.pipe(outStream);
child.stderr.pipe(process.stderr);
child.stdin.end(instruction);

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGKILL");
}, Math.max(10_000, timeoutMs - 10_000));

const exitCode = await new Promise((resolveExit) => child.once("close", (code) => resolveExit(code ?? 1)));
clearTimeout(timer);
outStream.end();
await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});

const raw = await readFile(outPath, "utf8").catch(() => "");
let inputTokens = 0;
let outputTokens = 0;
let cachedTokens = 0;
let modelSteps = 0;
let firstStepInputTokens;
const toolCalls = {};
for (const line of raw.split("\\n")) {
  if (!line.trim()) continue;
  try {
    const ev = JSON.parse(line);
    if (ev.type === "message_end" && ev.message?.role === "assistant") {
      modelSteps++;
      const u = ev.message.usage ?? {};
      const inTok = Number(u.input ?? 0) + Number(u.cacheRead ?? 0) + Number(u.cacheWrite ?? 0);
      inputTokens += inTok;
      outputTokens += Number(u.output ?? 0);
      cachedTokens += Number(u.cacheRead ?? 0);
      if (firstStepInputTokens === undefined && inTok > 0) firstStepInputTokens = inTok;
      for (const block of Array.isArray(ev.message.content) ? ev.message.content : []) {
        if (block?.type === "toolCall" && typeof block.name === "string") {
          toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1;
        }
      }
    }
  } catch {}
}

const piResult = {
  status: timedOut ? "timeout" : exitCode === 0 ? "completed" : "failed",
  exitCode,
  durationMs: Date.now() - startedAt,
  overhead: {
    firstStepInputTokens,
    modelSteps,
    toolCalls,
  },
};
if (inputTokens > 0 || outputTokens > 0) {
  piResult.usage = { inputTokens, outputTokens, cachedTokens };
}
await writeFile(join(logsDir, "result.json"), JSON.stringify(piResult, null, 2) + "\\n");
process.exit(timedOut ? 124 : exitCode);
`;

async function preparePi(cacheDir: string, _reasoning: ReasoningLevel): Promise<HarnessBundle> {
  const version = PEER_VERSIONS.pi;
  const archDirs = await ensureNodeRuntime(cacheDir);
  const key = createHash("sha256")
    .update(`pi:${version}:${PI_RUNNER_MJS}`)
    .digest("hex")
    .slice(0, 12);
  const dest = join(cacheDir, `pi-${version}-${key}`);
  const marker = join(dest, ".ready");

  if (!(await exists(marker))) {
    const staging = `${dest}.${randomUUID()}.staging`;
    try {
      await mkdir(join(staging, "pi"), { recursive: true });
      await writeFile(
        join(staging, "pi/package.json"),
        `${JSON.stringify({ private: true, dependencies: { "@earendil-works/pi-coding-agent": version } })}\n`,
      );
      await exec("npm", ["install", "--no-audit", "--no-fund", "--omit=dev"], {
        cwd: join(staging, "pi"),
        maxBuffer: 16 * 1024 * 1024,
      });
      await writeFile(join(staging, "runner.mjs"), PI_RUNNER_MJS);
      await writeFile(join(staging, ".ready"), `${version}\n`);
      await rename(staging, dest).catch(async (error: unknown) => {
        if (!(await exists(marker))) throw error;
      });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  return {
    harness: "pi",
    version,
    dir: dest,
    archDirs,
    command: (ctx: HarnessRunContext) =>
      `exec '${ctx.installDir}/arch/node' '${ctx.installDir}/runner.mjs'`,
    env: (ctx: HarnessRunContext) => ({
      CODE_BENCH_INSTALL_DIR: ctx.installDir,
      CODE_BENCH_INSTRUCTION_PATH: ctx.instructionPath,
      CODE_BENCH_LOGS_DIR: ctx.logsDir,
      CODE_BENCH_MODEL: ctx.model,
      CODE_BENCH_REASONING: ctx.reasoning,
      CODE_BENCH_TIMEOUT_MS: String(ctx.agentTimeoutMs),
    }),
  };
}

const OPENCODE_RUNNER_MJS = `import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const installDir = process.env.CODE_BENCH_INSTALL_DIR;
const instructionPath = process.env.CODE_BENCH_INSTRUCTION_PATH;
const logsDir = process.env.CODE_BENCH_LOGS_DIR;
const rawModel = process.env.CODE_BENCH_MODEL;
const reasoning = process.env.CODE_BENCH_REASONING || "high";
const timeoutMs = Number(process.env.CODE_BENCH_TIMEOUT_MS) || 20 * 60 * 1000;
const apiKey = process.env.AI_GATEWAY_API_KEY;
if (!apiKey) throw new Error("AI_GATEWAY_API_KEY is required");

const anthropicMatch = /^anthropic\\/([^/]+)$/u.exec(rawModel);
const mappedModel = anthropicMatch ? "anthropic/" + anthropicMatch[1].replaceAll(".", "-") : "vercel/" + rawModel;
const modelFlag = reasoning ? mappedModel + "#" + reasoning : mappedModel;

const xdgConfig = join(logsDir, "xdg-config");
const xdgData = join(logsDir, "xdg-data");
const xdgState = join(logsDir, "xdg-state");
const xdgCache = join(logsDir, "xdg-cache");
await Promise.all([
  mkdir(join(xdgConfig, "opencode"), { recursive: true }),
  mkdir(xdgData, { recursive: true }),
  mkdir(xdgState, { recursive: true }),
  mkdir(xdgCache, { recursive: true }),
]);

await writeFile(
  join(xdgConfig, "opencode/opencode.json"),
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      provider: {
        anthropic: { options: { baseURL: "https://ai-gateway.vercel.sh/v1" } },
      },
      permission: { websearch: "deny", webfetch: "deny" },
    },
    null,
    2,
  ) + "\\n",
);

const env = {
  ...process.env,
  ANTHROPIC_API_KEY: apiKey,
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  XDG_CONFIG_HOME: xdgConfig,
  XDG_DATA_HOME: xdgData,
  XDG_STATE_HOME: xdgState,
  XDG_CACHE_HOME: xdgCache,
};

const instruction = await readFile(instructionPath, "utf8");
const eventsPath = join(logsDir, "events.ndjson");
const outStream = createWriteStream(eventsPath);
const startedAt = Date.now();
const bin = join(installDir, "arch/opencode");

const child = spawn(bin, ["run", "--standalone", "--format", "json", "--auto", "--thinking", "-m", modelFlag], {
  env,
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdout.pipe(outStream);
child.stderr.pipe(outStream);
child.stdin.end(instruction);

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGKILL");
}, Math.max(10_000, timeoutMs - 10_000));

const exitCode = await new Promise((resolveExit) => child.once("close", (code) => resolveExit(code ?? 1)));
clearTimeout(timer);
outStream.end();

const raw = await readFile(eventsPath, "utf8").catch(() => "");
let sessionId;
let inputTokens = 0;
let outputTokens = 0;
let cachedTokens = 0;
let costUsd = 0;
let pricedSteps = 0;
let totalSteps = 0;
for (const line of raw.split("\\n")) {
  if (!line.trim()) continue;
  try {
    const ev = JSON.parse(line);
    if (!sessionId && typeof ev.sessionID === "string") sessionId = ev.sessionID;
    if (ev.type === "step_finish" && ev.part?.tokens) {
      totalSteps++;
      const t = ev.part.tokens;
      const cache = t.cache ?? {};
      inputTokens += Number(t.input ?? 0) + Number(cache.read ?? 0) + Number(cache.write ?? 0);
      outputTokens += Number(t.output ?? 0);
      cachedTokens += Number(cache.read ?? 0);
      if (typeof ev.part.cost === "number" && ev.part.cost > 0) {
        costUsd += ev.part.cost;
        pricedSteps++;
      }
    }
  } catch {}
}

let modelSteps = totalSteps;
let firstStepInputTokens;
const toolCalls = {};
if (sessionId) {
  try {
    const { stdout } = await exec(bin, ["session", "export", "--standalone", sessionId], {
      env,
      timeout: 30_000,
      maxBuffer: 128 * 1024 * 1024,
    });
    const exported = JSON.parse(stdout);
    const messages = Array.isArray(exported.messages) ? exported.messages : [];
    modelSteps = 0;
    for (const msg of messages) {
      if (msg?.type !== "assistant" || !msg.tokens) continue;
      modelSteps++;
      if (modelSteps === 1) {
        const cache = msg.tokens.cache ?? {};
        firstStepInputTokens = Number(msg.tokens.input ?? 0) + Number(cache.read ?? 0) + Number(cache.write ?? 0);
      }
      for (const part of Array.isArray(msg.content) ? msg.content : []) {
        if (part?.type === "tool" && typeof part.name === "string") {
          toolCalls[part.name] = (toolCalls[part.name] ?? 0) + 1;
        }
      }
    }
  } catch {}
}

const ocResult = {
  status: timedOut ? "timeout" : exitCode === 0 ? "completed" : "failed",
  exitCode,
  durationMs: Date.now() - startedAt,
  overhead: {
    firstStepInputTokens,
    modelSteps,
    toolCalls,
  },
};
if (inputTokens > 0 || outputTokens > 0) {
  ocResult.usage = { inputTokens, outputTokens, cachedTokens };
  if (pricedSteps === totalSteps && costUsd > 0) ocResult.usage.costUsd = costUsd;
}
await writeFile(join(logsDir, "result.json"), JSON.stringify(ocResult, null, 2) + "\\n");
process.exit(timedOut ? 124 : exitCode);
`;

async function prepareOpenCode(
  cacheDir: string,
  _reasoning: ReasoningLevel,
): Promise<HarnessBundle> {
  const version = PEER_VERSIONS.opencode;
  const nodeDirs = await ensureNodeRuntime(cacheDir);
  const archDirs = Object.fromEntries(
    await Promise.all(
      LINUX_ARCHES.map(async (arch) => {
        const dest = join(cacheDir, `opencode-${version}-linux-${arch}`);
        if (!(await exists(join(dest, "opencode")))) {
          const filename = `cli-linux-${arch}-${version}.tgz`;
          const url = `https://registry.npmjs.org/@opencode/cli-linux-${arch}/-/${filename}`;
          const archive = join(cacheDir, `${filename}.${randomUUID()}.tgz`);
          const staging = `${dest}.${randomUUID()}.staging`;
          try {
            await mkdir(staging, { recursive: true });
            await downloadTo(url, archive, OPENCODE_SHA256[arch]);
            await exec("tar", ["-xzf", archive, "-C", staging, "package/bin/opencode"]);
            await copyFile(join(staging, "package/bin/opencode"), join(staging, "opencode"));
            await copyFile(join(nodeDirs[arch], "node"), join(staging, "node"));
            await rm(join(staging, "package"), { recursive: true, force: true });
            await Promise.all([
              chmod(join(staging, "opencode"), 0o755),
              chmod(join(staging, "node"), 0o755),
            ]);
            await rename(staging, dest).catch(async (error: unknown) => {
              if (!(await exists(join(dest, "opencode")))) throw error;
            });
          } finally {
            await rm(archive, { force: true });
            await rm(staging, { recursive: true, force: true });
          }
        }
        return [arch, dest] as const;
      }),
    ),
  ) as Record<LinuxArch, string>;

  const key = createHash("sha256")
    .update(`opencode:${version}:${OPENCODE_RUNNER_MJS}`)
    .digest("hex")
    .slice(0, 12);
  const dir = join(cacheDir, `opencode-bundle-${key}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "runner.mjs"), OPENCODE_RUNNER_MJS);

  return {
    harness: "opencode",
    version,
    dir,
    archDirs,
    command: (ctx: HarnessRunContext) =>
      `exec '${ctx.installDir}/arch/node' '${ctx.installDir}/runner.mjs'`,
    env: (ctx: HarnessRunContext) => ({
      CODE_BENCH_INSTALL_DIR: ctx.installDir,
      CODE_BENCH_INSTRUCTION_PATH: ctx.instructionPath,
      CODE_BENCH_LOGS_DIR: ctx.logsDir,
      CODE_BENCH_MODEL: ctx.model,
      CODE_BENCH_REASONING: ctx.reasoning,
      CODE_BENCH_TIMEOUT_MS: String(ctx.agentTimeoutMs),
    }),
  };
}

const FX_RUNNER_MJS = `import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const installDir = process.env.CODE_BENCH_INSTALL_DIR;
const instructionPath = process.env.CODE_BENCH_INSTRUCTION_PATH;
const logsDir = process.env.CODE_BENCH_LOGS_DIR;
const model = process.env.CODE_BENCH_MODEL;
const reasoning = process.env.CODE_BENCH_REASONING || "high";
const timeoutMs = Number(process.env.CODE_BENCH_TIMEOUT_MS) || 20 * 60 * 1000;

await mkdir(logsDir, { recursive: true });
const instruction = await readFile(instructionPath, "utf8");
const reportPath = join(logsDir, "fx.json");
const errPath = join(logsDir, "fx.stderr.txt");
const outStream = createWriteStream(reportPath);
const errStream = createWriteStream(errPath);
const startedAt = Date.now();

const env = { ...process.env, FX_PROVIDER: "gateway", FX_AUTO_UPGRADE: "0" };
delete env.VERCEL_OIDC_TOKEN;
delete env.OPENAI_API_KEY;
delete env.ANTHROPIC_API_KEY;

const child = spawn(
  join(installDir, "arch/fx"),
  ["ask", "--json", "--no-save", "--full-access", "--model", model, "--effort", reasoning],
  { env, stdio: ["pipe", "pipe", "pipe"] },
);
child.stdout.pipe(outStream);
child.stderr.pipe(errStream);
child.stdin.end(instruction);

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGKILL");
}, Math.max(10_000, timeoutMs - 10_000));

const exitCode = await new Promise((resolveExit) => child.once("close", (code) => resolveExit(code ?? 1)));
clearTimeout(timer);
outStream.end();
errStream.end();

const raw = await readFile(reportPath, "utf8").catch(() => "");
let parsed;
for (const candidate of [raw, ...raw.split(/\\r?\\n/u).reverse()]) {
  try {
    const obj = JSON.parse(candidate);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      parsed = obj;
      break;
    }
  } catch {}
}

const u = parsed?.usage ?? {};
const inputTokens = Number(u.input_tokens ?? 0);
const outputTokens = Number(u.output_tokens ?? 0);
const cachedTokens = Number(u.cache_read_tokens ?? 0);
const toolCalls = {};
for (const tc of Array.isArray(parsed?.tool_calls) ? parsed.tool_calls : []) {
  if (typeof tc?.name === "string") toolCalls[tc.name] = (toolCalls[tc.name] ?? 0) + 1;
}

const fxResult = {
  status: timedOut ? "timeout" : exitCode === 0 ? "completed" : "failed",
  exitCode,
  durationMs: Date.now() - startedAt,
  overhead: {
    modelSteps: typeof parsed?.steps === "number" ? parsed.steps : undefined,
    toolCalls,
  },
};
if (inputTokens > 0 || outputTokens > 0) {
  fxResult.usage = { inputTokens, outputTokens, cachedTokens };
}
await writeFile(join(logsDir, "result.json"), JSON.stringify(fxResult, null, 2) + "\\n");
process.exit(timedOut ? 124 : exitCode);
`;

async function prepareFx(cacheDir: string, _reasoning: ReasoningLevel): Promise<HarnessBundle> {
  const version = PEER_VERSIONS.fx;
  const nodeDirs = await ensureNodeRuntime(cacheDir);
  const archDirs = Object.fromEntries(
    await Promise.all(
      LINUX_ARCHES.map(async (arch) => {
        const dest = join(cacheDir, `fx-${version}-linux-${arch}`);
        if (!(await exists(join(dest, "fx")))) {
          const { target, sha256 } = FX_RELEASES[arch];
          const url = `https://releases.fx.sh/v${version}/fx-${target}.tar.gz`;
          const archive = join(cacheDir, `fx-${target}-${randomUUID()}.tar.gz`);
          const staging = `${dest}.${randomUUID()}.staging`;
          try {
            await mkdir(staging, { recursive: true });
            await downloadTo(url, archive, sha256);
            await exec("tar", ["-xzf", archive, "-C", staging, "fx"]);
            await copyFile(join(nodeDirs[arch], "node"), join(staging, "node"));
            await Promise.all([
              chmod(join(staging, "fx"), 0o755),
              chmod(join(staging, "node"), 0o755),
            ]);
            await rename(staging, dest).catch(async (error: unknown) => {
              if (!(await exists(join(dest, "fx")))) throw error;
            });
          } finally {
            await rm(archive, { force: true });
            await rm(staging, { recursive: true, force: true });
          }
        }
        return [arch, dest] as const;
      }),
    ),
  ) as Record<LinuxArch, string>;

  const key = createHash("sha256")
    .update(`fx:${version}:${FX_RUNNER_MJS}`)
    .digest("hex")
    .slice(0, 12);
  const dir = join(cacheDir, `fx-bundle-${key}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "runner.mjs"), FX_RUNNER_MJS);

  return {
    harness: "fx",
    version,
    dir,
    archDirs,
    command: (ctx: HarnessRunContext) =>
      `exec '${ctx.installDir}/arch/node' '${ctx.installDir}/runner.mjs'`,
    env: (ctx: HarnessRunContext) => ({
      CODE_BENCH_INSTALL_DIR: ctx.installDir,
      CODE_BENCH_INSTRUCTION_PATH: ctx.instructionPath,
      CODE_BENCH_LOGS_DIR: ctx.logsDir,
      CODE_BENCH_MODEL: ctx.model,
      CODE_BENCH_REASONING: ctx.reasoning,
      CODE_BENCH_TIMEOUT_MS: String(ctx.agentTimeoutMs),
    }),
  };
}
