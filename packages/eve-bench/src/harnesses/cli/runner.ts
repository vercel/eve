import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";

import type { HarnessRunContext } from "../../core/harness.ts";
import {
  GATEWAY_BASE_URL,
  executionPlan,
  validateOptions,
  type CliName,
  type CliOptions,
} from "./plan.ts";
import { SecretRedactor } from "./output.ts";

const OUTPUT_LIMIT = 64 * 1024 * 1024;
const INSTRUCTION_LIMIT = 1024 * 1024;

async function main(): Promise<number> {
  const ctx = JSON.parse(process.env.EVE_BENCH_CLI_CONTEXT!) as HarnessRunContext;
  const options = JSON.parse(process.env.EVE_BENCH_CLI_OPTIONS!) as CliOptions;
  const name = validateOptions(process.env.EVE_BENCH_CLI_NAME as CliName, options);
  const start = Date.now();
  let agentStart: number | undefined;
  let exitCode = 1;
  let failure: string | undefined;
  let signal: string | null = null;
  await mkdir(ctx.logsDir, { recursive: true });
  const runtimeDir = await mkdtemp(join(ctx.installDir, ".cli-runtime-"));
  const secret = process.env.AI_GATEWAY_API_KEY;
  try {
    if (!secret?.trim())
      throw new Error("AI_GATEWAY_API_KEY must be forwarded to the CLI runtime environment.");
    if (secret.length > 8192 || /[\r\n\0]/.test(secret))
      throw new Error("AI_GATEWAY_API_KEY has an invalid format.");
    if ((await stat(ctx.instructionPath)).size > INSTRUCTION_LIMIT)
      throw new Error("CLI instruction exceeds 1 MiB.");
    const instruction = await readFile(ctx.instructionPath, "utf8");
    const plan = executionPlan(name, options, ctx, runtimeDir, instruction);
    await mkdir(dirname(plan.configPath), { recursive: true });
    await writeFile(plan.configPath, plan.config, { mode: 0o600 });
    const { entry, native = false } = JSON.parse(
      await readFile(join(ctx.installDir, "arch/entry.json"), "utf8"),
    ) as { entry: string; native?: boolean };
    const executable = join(ctx.installDir, "arch", entry);
    // The CLI and its tool subprocesses keep the task container's own environment
    // (HOME, PATH, image ENV), as eve's tools do, so state they leave in the task
    // survives into verification. Only harness-owned config paths are added.
    const {
      EVE_BENCH_CLI_CONTEXT: _context,
      EVE_BENCH_CLI_OPTIONS: _options,
      EVE_BENCH_CLI_NAME: _name,
      AI_GATEWAY_API_KEY: _gatewayKey,
      OPENAI_API_KEY: _openaiKey,
      ...inherited
    } = process.env;
    const baseEnv = { ...(inherited as Record<string, string>), ...plan.env };
    const version = await run(
      executable,
      ["--version"],
      baseEnv,
      ctx,
      "cli-setup.log",
      secret,
      false,
      undefined,
      native,
    );
    const escapedVersion = options.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (
      version.code !== 0 ||
      !new RegExp(`(?:^|\\s)${escapedVersion}(?:\\s|$)`).test(version.text)
    ) {
      throw new Error(
        "Pinned CLI failed its --version check; native package/runtime compatibility must be checked before benchmarking.",
      );
    }
    agentStart = Date.now();
    const result = await run(
      executable,
      plan.args,
      { ...baseEnv, AI_GATEWAY_API_KEY: secret, OPENAI_API_KEY: secret },
      ctx,
      `${name}.jsonl`,
      secret,
      name !== "codex",
      plan.stdin,
      native,
    );
    exitCode = result.code;
    signal = result.signal;
    if (result.errorEvent && exitCode === 0) {
      exitCode = 1;
      failure = `${name} emitted an error event despite exiting zero.`;
    }
  } catch (error) {
    // Only our actionable messages are emitted; filesystem/spawn diagnostics can contain arbitrary data.
    const message = error instanceof Error ? error.message : "";
    failure =
      /^(AI_GATEWAY_API_KEY |CLI instruction |Pinned CLI |CLI model |Unsupported .* reasoning)/.test(
        message,
      )
        ? message
        : "CLI setup or execution failed; inspect the redacted CLI logs and the pinned bundle.";
  } finally {
    const end = Date.now();
    await rm(runtimeDir, { recursive: true, force: true });
    const runtime: Record<string, unknown> = {
      name,
      version: options.version,
      model: ctx.model,
      baseUrl: options.baseUrl ?? GATEWAY_BASE_URL,
      reasoning: options.reasoning ?? null,
      protocol: name === "codex" ? "responses" : "chat-completions",
      installLocation: "host",
      containerInstallMs: 0,
      setupMs: (agentStart ?? end) - start,
      agentMs: agentStart === undefined ? 0 : end - agentStart,
      exitCode,
      signal,
    };
    if (failure) runtime.failure = failure;
    await writeFile(join(ctx.logsDir, "cli-runtime.json"), `${JSON.stringify(runtime, null, 2)}\n`);
  }
  if (failure) process.stderr.write(`[eve-bench] ${failure}\n`);
  return exitCode;
}

async function run(
  entry: string,
  args: string[],
  env: Record<string, string>,
  ctx: HarnessRunContext,
  logName: string,
  secret: string,
  detectErrors = false,
  input?: string,
  native = false,
): Promise<{ code: number; signal: string | null; text: string; errorEvent: boolean }> {
  const log = createWriteStream(join(ctx.logsDir, logName), { mode: 0o600 });
  let bytes = 0;
  let text = "";
  let line = "";
  let skipLine = false;
  let errorEvent = false;
  let truncated = false;
  const emit = (chunk: string, stdout: boolean) => {
    if (stdout && detectErrors) {
      for (const piece of chunk.split(/(?<=\n)/)) {
        if (!skipLine) line += piece;
        if (line.length > INSTRUCTION_LIMIT) {
          line = "";
          skipLine = true;
        }
        if (piece.endsWith("\n")) {
          if (!skipLine) {
            try {
              if (isErrorEvent(JSON.parse(line))) errorEvent = true;
            } catch {
              /* Native diagnostics need not be JSON. */
            }
          }
          line = "";
          skipLine = false;
        }
      }
    }
    if (text.length < 65536) text += chunk.slice(0, 65536 - text.length);
    const buffer = Buffer.from(chunk);
    const kept = buffer.subarray(0, Math.max(0, OUTPUT_LIMIT - bytes));
    bytes += kept.length;
    if (kept.length > 0) {
      log.write(kept);
      process.stdout.write(kept);
    }
    if (!truncated && kept.length < buffer.length) {
      truncated = true;
      log.write("\n[eve-bench] CLI output truncated at 64 MiB\n");
      process.stdout.write("\n[eve-bench] CLI output truncated at 64 MiB\n");
    }
  };
  const child = spawn(native ? entry : process.execPath, native ? args : [entry, ...args], {
    cwd: ctx.taskWorkdir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  // A CLI may exit before consuming stdin; its exit status remains authoritative.
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  const forwardTerm = () => child.kill("SIGTERM");
  const forwardInt = () => child.kill("SIGINT");
  process.on("SIGTERM", forwardTerm);
  process.on("SIGINT", forwardInt);
  const stdout = new SecretRedactor(secret);
  const stderr = new SecretRedactor(secret);
  child.stdout.on("data", (chunk: Buffer) => emit(stdout.push(chunk), true));
  child.stderr.on("data", (chunk: Buffer) => emit(stderr.push(chunk), false));
  let spawnFailed = false;
  child.on("error", () => {
    spawnFailed = true;
  });
  const result = await new Promise<{ code: number; signal: string | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code: spawnFailed ? 1 : (code ?? 1), signal }));
  });
  process.off("SIGTERM", forwardTerm);
  process.off("SIGINT", forwardInt);
  emit(stdout.finish(), true);
  emit(stderr.finish(), false);
  if (detectErrors && line && !skipLine) {
    try {
      if (isErrorEvent(JSON.parse(line))) errorEvent = true;
    } catch {
      /* Partial diagnostic. */
    }
  }
  log.end();
  await finished(log);
  return { ...result, text, errorEvent };
}

function isErrorEvent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const event = value as { type?: string; errorMessage?: unknown; message?: unknown };
  if (event.type === "error" || typeof event.errorMessage === "string") return true;
  return event.message !== undefined && isErrorEvent(event.message);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.stderr.write("[eve-bench] Invalid CLI runtime context or unwritable logs directory.\n");
    process.exitCode = 1;
  },
);
