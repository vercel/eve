import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const WITHHELD_TASK_ENV = new Set([
  "AI_GATEWAY_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "EVE_BENCH_TOKEN",
  "EVE_DEV",
]);

function snapshotTaskEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) =>
        value !== undefined && !WITHHELD_TASK_ENV.has(key) && !key.startsWith("CODE_BENCH_"),
    ),
  );
}

export function summarizeEvents(streamEvents) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let costUsd = 0;
  let usageCount = 0;
  let pricedCount = 0;
  let modelSteps = 0;
  let firstStepInputTokens;
  const toolCalls = {};
  const partsById = new Map();
  let lastTurnSettled;
  let failure;

  for (const event of streamEvents) {
    const data = event.data ?? {};
    if (event.type === "model.settled") {
      modelSteps += 1;
    } else if (
      event.type === "usage.recorded" &&
      (data.kind === "model" || data.kind === "delegated-late") &&
      data.usage
    ) {
      const u = data.usage;
      const inTok = Number(u.inputTokens ?? 0);
      const outTok = Number(u.outputTokens ?? 0);
      const cacheTok = Number(u.cacheReadTokens ?? u.cachedInputTokens ?? 0);
      inputTokens += inTok;
      outputTokens += outTok;
      cachedTokens += cacheTok;
      usageCount += 1;
      if (data.kind === "model" && firstStepInputTokens === undefined && inTok > 0) {
        firstStepInputTokens = inTok;
      }
      if (typeof u.costUsd === "number" && Number.isFinite(u.costUsd)) {
        costUsd += u.costUsd;
        pricedCount += 1;
      }
    } else if (event.type === "call.requested" && data.capability?.name) {
      const name = String(data.capability.name);
      toolCalls[name] = (toolCalls[name] ?? 0) + 1;
    } else if (event.type === "content.completed" && data.partId) {
      partsById.set(data.partId, data);
    } else if (event.type === "turn.settled") {
      lastTurnSettled = data;
      if (data.outcome && data.outcome !== "completed") {
        failure = {
          type: "turn.failed",
          message: data.error?.message ?? `turn settled with outcome ${data.outcome}`,
        };
      }
    } else if (event.type === "delivery.settled") {
      if (
        (data.outcome === "failed" ||
          data.outcome === "refused" ||
          data.outcome === "awaiting-input") &&
        !failure
      ) {
        failure = {
          type: "delivery.failed",
          message: data.reason ?? `delivery settled with outcome ${data.outcome}`,
        };
      }
    } else if (event.type === "session.ended" && data.outcome && data.outcome !== "completed") {
      failure = {
        type: "session.failed",
        message: data.error?.message ?? `session ended with outcome ${data.outcome}`,
      };
    }
  }

  let message = "";
  if (lastTurnSettled && Array.isArray(lastTurnSettled.reply)) {
    message = lastTurnSettled.reply
      .map((partId) => partsById.get(partId))
      .filter(
        (part) => part?.kind === "text" && part.phase === "reply" && typeof part.value === "string",
      )
      .map((part) => part.value)
      .join("\n");
  }

  let usage;
  if (usageCount > 0) {
    usage = { inputTokens, outputTokens, cachedTokens };
    if (pricedCount === usageCount) usage.costUsd = costUsd;
  }
  const overhead = { modelSteps, toolCalls };
  if (firstStepInputTokens !== undefined) overhead.firstStepInputTokens = firstStepInputTokens;

  return { message, failure, usage, overhead };
}

function startProductionServer({
  projectDir,
  host,
  port,
  token,
  taskEnv,
  model,
  workdir,
  logPath,
}) {
  const log = createWriteStream(logPath, { flags: "a" });
  log.on("error", () => {});
  const entry = join(projectDir, ".output", "server", "index.mjs");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    HOST: host,
    NITRO_HOST: host,
    NITRO_PORT: String(port),
    PORT: String(port),
    EVE_BENCH_TOKEN: token,
    CODE_BENCH_TASK_CONTAINER: "1",
    CODE_BENCH_TASK_WORKDIR: workdir,
    CODE_BENCH_TASK_ENV: taskEnv,
    EVE_CODE_BENCH_MODEL: model,
  };
  delete env.EVE_DEV;
  delete env.CI;
  delete env.TEST;

  const child = spawn(process.execPath, [entry], {
    cwd: projectDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.once("exit", (code, signal) => {
    log.write(`\n[eve-server exited code=${code ?? ""} signal=${signal ?? ""}]\n`);
    log.end();
  });
  return child;
}

const isServerExited = (child) => child.exitCode !== null || child.signalCode !== null;

async function waitForHealth(client, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (isServerExited(child)) {
      throw new Error(
        `eve server exited before becoming healthy (code=${child.exitCode ?? ""} signal=${child.signalCode ?? ""})`,
      );
    }
    try {
      await client.health();
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Timed out waiting for eve health: ${lastError?.message ?? "unknown"}`);
}

async function stopServerGracefully(child) {
  if (isServerExited(child)) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 2_000)),
  ]);
  if (!exited && !isServerExited(child)) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
    ]);
  }
}

async function main() {
  const { Client } = await import("eve/client");
  const taskEnv = JSON.stringify(snapshotTaskEnv(process.env));
  const installDir = process.env.CODE_BENCH_INSTALL_DIR || "/installed-agent";
  const projectDir = join(installDir, "app");
  const instructionPath = process.env.CODE_BENCH_INSTRUCTION || "/task/instruction.md";
  const logsDir = process.env.CODE_BENCH_LOGS_DIR || "/logs/agent";
  const workdir = process.env.CODE_BENCH_TASK_WORKDIR || "/app";
  const model = process.env.CODE_BENCH_MODEL || "anthropic/claude-sonnet-5.5";
  const host = process.env.EVE_HOST ?? "127.0.0.1";
  const port = Number(process.env.EVE_PORT ?? "3024");
  const token = randomBytes(24).toString("hex");
  const configuredTimeoutMs = Number(process.env.CODE_BENCH_TIMEOUT_MS);
  const agentTimeoutMs =
    Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? configuredTimeoutMs
      : 20 * 60 * 1000;
  const streamTimeoutMs = Math.max(10_000, agentTimeoutMs - Math.min(20_000, agentTimeoutMs / 10));

  await mkdir(logsDir, { recursive: true });
  const eventsPath = join(logsDir, "events.ndjson");
  const resultPath = join(logsDir, "result.json");
  const serverLogPath = join(logsDir, "server.log");

  const startedAt = Date.now();
  let server;
  let session;
  const events = [];
  let timedOut = false;
  let caughtError = null;

  try {
    server = startProductionServer({
      projectDir,
      host,
      port,
      token,
      taskEnv,
      model,
      workdir,
      logPath: serverLogPath,
    });
    const client = new Client({
      baseUrl: `http://${host}:${port}`,
      auth: { basic: { username: "code-bench", password: token } },
    });
    await waitForHealth(client, server, 60_000);

    const instruction = await readFile(instructionPath, "utf8");
    const created = await client.sessions.create({ message: instruction });
    session = created.session;

    const eventStream = createWriteStream(eventsPath, { flags: "w" });
    eventStream.on("error", () => {});
    const deadline = AbortSignal.timeout(streamTimeoutMs);
    try {
      for await (const event of created.delivery.stream({ signal: deadline })) {
        events.push(event);
        eventStream.write(`${JSON.stringify(event)}\n`);
      }
    } catch (error) {
      if (deadline.aborted) timedOut = true;
      else throw error;
    } finally {
      eventStream.end();
      await finished(eventStream).catch(() => {});
    }
  } catch (error) {
    caughtError = error;
  } finally {
    const metrics = summarizeEvents(events);
    const failure = caughtError
      ? {
          type: "runner.error",
          message: caughtError instanceof Error ? caughtError.message : String(caughtError),
        }
      : metrics.failure;
    const status = timedOut ? "timeout" : failure ? "failed" : "completed";
    const exitCode = timedOut ? 124 : failure ? 1 : 0;

    const summary = {
      status,
      exitCode,
      durationMs: Date.now() - startedAt,
      sessionId: session?.id,
      message: metrics.message,
      usage: metrics.usage,
      overhead: metrics.overhead,
    };
    if (failure) {
      summary.failure = failure;
      summary.error = failure.message;
    }
    await writeFile(resultPath, `${JSON.stringify(summary, null, 2)}\n`).catch(() => {});
    if (caughtError) process.stderr.write(`${failure.message}\n`);
    process.exitCode = exitCode;

    if (session) {
      try {
        const endDelivery = await session.end({ signal: AbortSignal.timeout(5_000) });
        await endDelivery.result({ signal: AbortSignal.timeout(5_000) });
      } catch {}
    }
    if (server) {
      await stopServerGracefully(server);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
