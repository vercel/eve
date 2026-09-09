// Runs inside the task container: boots the built eve server, sends the task
// instruction as one session, follows the event stream to its boundary, and
// writes /logs/agent/{events.ndjson,result.json,server.log}. Talks to the
// server over plain HTTP so the bundle ships no node_modules.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const projectDir = requireEnv("EVE_PROJECT_DIR");
const instructionPath = requireEnv("EVE_INSTRUCTION_PATH");
const logsDir = process.env.EVE_AGENT_LOGS_DIR ?? "/logs/agent";
const host = process.env.EVE_HOST ?? "127.0.0.1";
const port = Number(process.env.EVE_PORT ?? "3024");
const serverUrl = `http://${host}:${port}`;
const startupTimeoutMs = Number(process.env.EVE_STARTUP_TIMEOUT_MS ?? "60000");

await mkdir(logsDir, { recursive: true });
const eventsPath = join(logsDir, "events.ndjson");
const resultPath = join(logsDir, "result.json");
const serverLogPath = join(logsDir, "server.log");

let server;
let wroteResult = false;
try {
  server = startServer();
  await waitForHealth(server);

  const instruction = await readFile(instructionPath, "utf8");
  const sessionId = await createSession(instruction);
  const events = await followStream(sessionId);

  await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const status = statusFromEvents(events);
  const summary = {
    status,
    sessionId,
    message: finalMessage(events),
    inputRequests: events
      .filter((event) => event.type === "input.requested")
      .flatMap((event) => event.data?.requests ?? []),
    usage: summarizeUsage(events),
    eventCount: events.length,
    failure: failureFromEvents(events) ?? failureFromStatus(status),
  };
  await writeFile(resultPath, `${JSON.stringify(summary, null, 2)}\n`);
  wroteResult = true;
  if (summary.failure) throw new Error(summary.failure.message);
} catch (error) {
  if (!wroteResult) {
    await writeFile(
      resultPath,
      `${JSON.stringify(
        {
          status: "failed",
          inputRequests: [],
          usage: {},
          eventCount: 0,
          failure: { type: "runner.error", message: error?.message ?? String(error) },
        },
        null,
        2,
      )}\n`,
    );
  }
  throw error;
} finally {
  if (server) await stopServer(server);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function startServer() {
  const log = createWriteStream(serverLogPath, { flags: "a" });
  const entry = join(projectDir, ".output", "server", "index.mjs");
  const child = spawn(process.execPath, [entry], {
    cwd: projectDir,
    env: {
      ...process.env,
      EVE_DEV: "1",
      HOST: host,
      NITRO_HOST: host,
      NITRO_PORT: String(port),
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.once("exit", (code, signal) => {
    log.write(`\n[eve-server exited code=${code ?? ""} signal=${signal ?? ""}]\n`);
  });
  return child;
}

async function waitForHealth(child) {
  const deadline = Date.now() + startupTimeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`eve server exited before becoming healthy (code ${child.exitCode})`);
    }
    try {
      const response = await fetch(`${serverUrl}/eve/v1/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for eve health: ${lastError?.message ?? "unknown"}`);
}

async function createSession(message) {
  const response = await fetch(`${serverUrl}/eve/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!response.ok)
    throw new Error(`session create failed: ${response.status} ${await response.text()}`);
  const payload = await response.json();
  const sessionId = payload?.sessionId ?? response.headers.get("x-eve-session-id");
  if (!sessionId) throw new Error("session create returned no session id");
  return sessionId;
}

/** Reads the durable NDJSON stream until a session boundary, reconnecting from the cursor if the transport ends first. */
async function followStream(sessionId) {
  const events = [];
  for (;;) {
    const url = new URL(`${serverUrl}/eve/v1/session/${encodeURIComponent(sessionId)}/stream`);
    if (events.length > 0) url.searchParams.set("startIndex", String(events.length));
    const response = await fetch(url);
    if (!response.ok || !response.body)
      throw new Error(`stream failed: ${response.status} ${await response.text()}`);
    for await (const event of ndjson(response.body)) {
      events.push(event);
      if (isBoundary(event)) return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function* ndjson(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}

function isBoundary(event) {
  return (
    event.type === "session.completed" ||
    event.type === "session.failed" ||
    event.type === "session.waiting"
  );
}

function statusFromEvents(events) {
  const boundary = events.findLast(isBoundary);
  if (boundary?.type === "session.completed") return "completed";
  if (boundary?.type === "session.waiting") return "waiting";
  if (boundary?.type === "session.failed") return "failed";
  return "unknown";
}

function finalMessage(events) {
  return events.findLast(
    (event) => event.type === "message.completed" && event.data?.finishReason !== "tool-calls",
  )?.data?.message;
}

function failureFromEvents(events) {
  for (const event of events) {
    if (event.type === "input.requested") {
      return {
        type: event.type,
        message: "eve requested human input during a non-interactive benchmark run",
        data: event.data,
      };
    }
    if (event.type === "turn.failed" || event.type === "session.failed") {
      const message =
        event.data?.message ?? event.data?.error?.message ?? `${event.type} emitted during eve run`;
      return { type: event.type, message, data: event.data };
    }
  }
  return null;
}

function failureFromStatus(status) {
  if (status === "waiting" || status === "completed") return null;
  return { type: "session.unsettled", message: `eve run ended with status: ${status}` };
}

function summarizeUsage(events) {
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
  for (const event of events) {
    if (event.type !== "step.completed") continue;
    const source = event.data?.usage ?? event.data ?? {};
    usage.inputTokens += numberValue(source.inputTokens, source.input_tokens);
    usage.outputTokens += numberValue(source.outputTokens, source.output_tokens);
    usage.cachedTokens += numberValue(
      source.cacheReadTokens,
      source.cachedTokens,
      source.cached_tokens,
    );
    usage.costUsd += numberValue(source.costUsd, source.cost_usd);
  }
  return usage;
}

function numberValue(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
