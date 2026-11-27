import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";

import { Client } from "eve/client";

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
      ([key, value]) => value !== undefined && !WITHHELD_TASK_ENV.has(key),
    ),
  );
}

const taskEnv = JSON.stringify(snapshotTaskEnv(process.env));
const projectDir = requireEnv("EVE_PROJECT_DIR");
const instructionPath = requireEnv("EVE_INSTRUCTION_PATH");
const logsDir = process.env.EVE_AGENT_LOGS_DIR ?? "/logs/agent";
const host = process.env.EVE_HOST ?? "127.0.0.1";
const port = Number(process.env.EVE_PORT ?? "3024");
const serverUrl = `http://${host}:${port}`;
const token = randomBytes(24).toString("hex");
const startupTimeoutMs = 60_000;
const configuredTimeoutMs = Number(process.env.EVE_AGENT_TIMEOUT_MS);
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

try {
  await restoreHostResources(projectDir);
  server = startProductionServer({ projectDir, host, port, token, taskEnv, serverLogPath });

  const client = new Client({
    baseUrl: serverUrl,
    auth: { basic: { username: "code-bench", password: token } },
  });
  await waitForHealth(client, server, startupTimeoutMs);

  const instruction = await readFile(instructionPath, "utf8");
  const created = await client.sessions.create({ message: instruction });
  session = created.session;

  const eventStream = createWriteStream(eventsPath, { flags: "w" });
  const deadline = AbortSignal.timeout(streamTimeoutMs);
  let timedOut = false;

  try {
    for await (const event of created.delivery.stream({ signal: deadline })) {
      events.push(event);
      eventStream.write(`${JSON.stringify(event)}\n`);
    }
  } catch (error) {
    if (deadline.aborted) {
      timedOut = true;
    } else {
      throw error;
    }
  } finally {
    eventStream.end();
    await finished(eventStream).catch(() => {});
  }

  const metrics = summarizeEvents(events);
  const summary = {
    status: timedOut ? "timeout" : metrics.failure ? "failed" : "completed",
    exitCode: timedOut || metrics.failure ? 1 : 0,
    durationMs: Date.now() - startedAt,
    sessionId: session.id,
    message: metrics.message,
    usage: metrics.usage,
    overhead: metrics.overhead,
    ...(metrics.failure ? { failure: metrics.failure } : {}),
  };
  await writeFile(resultPath, `${JSON.stringify(summary, null, 2)}\n`);

  if (timedOut) {
    process.exitCode = 124;
  } else if (metrics.failure) {
    process.exitCode = 1;
  }
} catch (error) {
  const metrics = summarizeEvents(events);
  const message = error instanceof Error ? error.message : String(error);
  await writeFile(
    resultPath,
    `${JSON.stringify(
      {
        status: "failed",
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        sessionId: session?.id,
        usage: metrics.usage,
        overhead: metrics.overhead,
        failure: { type: "runner.error", message },
      },
      null,
      2,
    )}\n`,
  );
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
} finally {
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

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

async function restoreHostResources(appDir) {
  const hostResources = join(appDir, ".output/server/agent");
  if (existsSync(hostResources) && !existsSync(join(appDir, "agent"))) {
    await cp(hostResources, join(appDir, "agent"), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
}

function startProductionServer({
  projectDir: cwd,
  host: bindHost,
  port: bindPort,
  token: authToken,
  taskEnv: envJson,
  serverLogPath: logPath,
}) {
  const log = createWriteStream(logPath, { flags: "a" });
  const entry = join(cwd, ".output", "server", "index.mjs");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    HOST: bindHost,
    NITRO_HOST: bindHost,
    NITRO_PORT: String(bindPort),
    PORT: String(bindPort),
    EVE_BENCH_TOKEN: authToken,
    CODE_BENCH_TASK_ENV: envJson,
  };
  delete env.EVE_DEV;

  const child = spawn(process.execPath, [entry], {
    cwd,
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

async function waitForHealth(client, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`eve server exited before becoming healthy (code ${child.exitCode})`);
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
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 2000)),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1000)),
    ]);
  }
}

function summarizeEvents(streamEvents) {
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
      modelSteps++;
    } else if (event.type === "usage.recorded" && data.kind === "model" && data.usage) {
      const u = data.usage;
      const inTok = Number(u.inputTokens ?? 0);
      const outTok = Number(u.outputTokens ?? 0);
      const cacheTok = Number(u.cacheReadTokens ?? u.cachedInputTokens ?? 0);
      inputTokens += inTok;
      outputTokens += outTok;
      cachedTokens += cacheTok;
      usageCount++;
      if (firstStepInputTokens === undefined && inTok > 0) {
        firstStepInputTokens = inTok;
      }
      if (typeof u.costUsd === "number" && Number.isFinite(u.costUsd)) {
        costUsd += u.costUsd;
        pricedCount++;
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

  return {
    message,
    failure,
    usage:
      usageCount > 0
        ? {
            inputTokens,
            outputTokens,
            cachedTokens,
            ...(pricedCount === usageCount ? { costUsd } : {}),
          }
        : undefined,
    overhead: {
      ...(firstStepInputTokens !== undefined ? { firstStepInputTokens } : {}),
      modelSteps,
      toolCalls,
    },
  };
}
