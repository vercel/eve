import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REASONING_TO_PI = { none: "off", low: "low", medium: "medium", high: "high", xhigh: "xhigh" };

export function buildOpencodeConfig(rawModel) {
  const provider = {
    anthropic: { options: { baseURL: "https://ai-gateway.vercel.sh/v1" } },
  };
  if (!rawModel.startsWith("anthropic/")) {
    provider.vercel = {
      models: {
        [rawModel]: {
          name: rawModel,
          reasoning: true,
          limit: { context: 1_050_000, output: 128_000 },
        },
      },
    };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    provider,
    permission: { websearch: "deny", webfetch: "deny" },
  };
}

function parseJsonLines(raw) {
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

function sumOpencodeTokenEntries(entries) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let costUsd = 0;
  let pricedSteps = 0;
  let modelSteps = 0;
  let firstStepInputTokens;

  for (const { tokens: t, cost } of entries) {
    if (!t) continue;
    const inp = Number(t.input ?? 0) + Number(t.cache?.read ?? 0) + Number(t.cache?.write ?? 0);
    const out = Number(t.output ?? 0) + Number(t.reasoning ?? 0);
    if (inp === 0 && out === 0) continue;
    modelSteps += 1;
    if (firstStepInputTokens === undefined && inp > 0) firstStepInputTokens = inp;
    inputTokens += inp;
    outputTokens += out;
    cachedTokens += Number(t.cache?.read ?? 0);
    if (typeof cost === "number" && cost > 0) {
      costUsd += cost;
      pricedSteps += 1;
    }
  }

  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    costUsd: modelSteps > 0 && pricedSteps === modelSteps && costUsd > 0 ? costUsd : undefined,
    firstStepInputTokens,
    modelSteps,
  };
}

export function parsePiJsonl(raw) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let firstStepInputTokens;
  let modelSteps = 0;
  let toolCalls = 0;
  let lastStopReason;
  let lastAssistantError;

  for (const ev of parseJsonLines(raw)) {
    if (ev.type === "tool_execution_start") toolCalls += 1;
    if (ev.type !== "message_end" || ev.message?.role !== "assistant") continue;
    lastStopReason = ev.message.stopReason;
    if (typeof ev.message.errorMessage === "string" && ev.message.errorMessage) {
      lastAssistantError = ev.message.errorMessage;
    }
    const u = ev.message.usage;
    if (!u || typeof u !== "object") continue;
    const inp = Number(u.input ?? 0) + Number(u.cacheRead ?? 0) + Number(u.cacheWrite ?? 0);
    const out = Number(u.output ?? 0);
    if (inp === 0 && out === 0) continue;
    modelSteps += 1;
    if (firstStepInputTokens === undefined && inp > 0) firstStepInputTokens = inp;
    inputTokens += inp;
    outputTokens += out;
    cachedTokens += Number(u.cacheRead ?? 0);
  }

  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    firstStepInputTokens,
    modelSteps,
    toolCalls,
    failedByStopReason: lastStopReason === "error" || lastStopReason === "aborted",
    lastAssistantError,
  };
}

export function parseOpencodeEvents(raw, exportedMessages) {
  let sessionId;
  let toolCalls = 0;
  const eventEntries = [];

  for (const ev of parseJsonLines(raw)) {
    if (typeof ev.sessionID === "string" && !sessionId) sessionId = ev.sessionID;
    if (ev.type === "tool_use") toolCalls += 1;
    if (ev.type === "step_finish" && ev.part?.tokens) {
      eventEntries.push({ tokens: ev.part.tokens, cost: ev.part.cost });
    }
  }

  const fromEvents = sumOpencodeTokenEntries(eventEntries);
  if (Array.isArray(exportedMessages) && exportedMessages.length > 0) {
    const fromExport = sumOpencodeTokenEntries(
      exportedMessages.map((msg) => ({
        tokens: msg?.tokens ?? msg?.info?.tokens,
        cost: msg?.cost ?? msg?.info?.cost,
      })),
    );
    if (fromExport.modelSteps > 0) {
      return {
        sessionId,
        toolCalls,
        ...fromExport,
        firstStepInputTokens: fromExport.firstStepInputTokens ?? fromEvents.firstStepInputTokens,
      };
    }
  }
  return { sessionId, toolCalls, ...fromEvents };
}

export function parseFxOutput(raw) {
  let parsed;
  for (const candidate of [raw, ...raw.split(/\r?\n/u).reverse()]) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        parsed = obj;
        break;
      }
    } catch {}
  }
  if (!parsed) return { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

  const usages = [
    ...(parsed.usage && typeof parsed.usage === "object" ? [parsed.usage] : []),
    ...(Array.isArray(parsed.subagents)
      ? parsed.subagents.map((s) => s?.usage).filter(Boolean)
      : []),
  ];
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  for (const u of usages) {
    inputTokens += Number(u.input_tokens ?? u.inputTokens ?? 0);
    outputTokens += Number(u.output_tokens ?? u.outputTokens ?? 0);
    cachedTokens += Number(u.cache_read_tokens ?? u.cacheReadInputTokens ?? 0);
  }
  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    modelSteps: typeof parsed.steps === "number" ? parsed.steps : undefined,
    toolCalls: Array.isArray(parsed.tool_calls) ? parsed.tool_calls.length : undefined,
  };
}

function signalProcessGroup(child, signal) {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try {
    child.kill(signal);
  } catch {}
}

async function runProcess({ cmd, args, cwd, env, stdinText, stdoutPath, stderrPath, timeoutMs }) {
  const outStream = createWriteStream(stdoutPath);
  const errStream = createWriteStream(stderrPath);
  outStream.on("error", () => {});
  errStream.on("error", () => {});

  const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});
  child.stdout.pipe(outStream, { end: false });
  child.stderr.pipe(errStream, { end: false });
  child.stdin.end(stdinText ?? "");

  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      signalProcessGroup(child, "SIGTERM");
      setTimeout(() => signalProcessGroup(child, "SIGKILL"), 5_000).unref();
    },
    Math.max(10_000, timeoutMs - 10_000),
  );

  const exitCode = await new Promise((resolve) => {
    child.once("close", (code) => resolve(code ?? 1));
    child.once("error", () => resolve(1));
  });
  clearTimeout(timer);

  outStream.end();
  errStream.end();
  await Promise.all([finished(outStream).catch(() => {}), finished(errStream).catch(() => {})]);
  return { exitCode, timedOut };
}

function makeOutcome({ exitCode, timedOut, parsed, failedExtra = false, error }) {
  const failed = !timedOut && (exitCode !== 0 || failedExtra);
  const effectiveExit = timedOut ? 124 : failed ? exitCode || 1 : 0;
  const outcome = {
    status: timedOut ? "timeout" : failed ? "failed" : "completed",
    exitCode: effectiveExit,
    overhead: {
      firstStepInputTokens: parsed.firstStepInputTokens,
      modelSteps: parsed.modelSteps,
      toolCalls: parsed.toolCalls,
    },
  };
  if (parsed.inputTokens > 0 || parsed.outputTokens > 0) {
    outcome.usage = {
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      cachedTokens: parsed.cachedTokens,
    };
    if (parsed.costUsd !== undefined) outcome.usage.costUsd = parsed.costUsd;
  }
  if (error) outcome.error = error;
  return outcome;
}

async function hasBuiltInPiModel(piBin, env, provider, modelId) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [piBin, "--list-models", modelId], {
      env,
      timeout: 15_000,
    });
    return stdout.split("\n").some((line) => {
      const cols = line.trim().split(/\s+/u);
      return cols[0] === provider && cols[1] === modelId;
    });
  } catch {
    return false;
  }
}

async function runPi({
  installDir,
  logsDir,
  workdir,
  rawModel,
  reasoning,
  instruction,
  timeoutMs,
}) {
  const piBin = join(installDir, "node_modules/.bin/pi");
  const agentDir = join(logsDir, "pi-agent");
  await mkdir(agentDir, { recursive: true });
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
  const isAnthropic = rawModel.startsWith("anthropic/");
  let provider = isAnthropic ? "anthropic" : "openai";
  let modelId = rawModel.includes("/") ? rawModel.slice(rawModel.indexOf("/") + 1) : rawModel;

  if (process.env.AI_GATEWAY_API_KEY) {
    modelId = rawModel;
    if (await hasBuiltInPiModel(piBin, env, "vercel-ai-gateway", rawModel)) {
      provider = "vercel-ai-gateway";
    } else {
      provider = "code-bench-gateway";
      const modelEntry = {
        id: rawModel,
        name: rawModel,
        reasoning: true,
        input: ["text", "image"],
        contextWindow: isAnthropic ? 1_000_000 : 1_050_000,
        maxTokens: 128_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      await writeFile(
        join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            "code-bench-gateway": {
              baseUrl: isAnthropic
                ? "https://ai-gateway.vercel.sh"
                : "https://ai-gateway.vercel.sh/v1",
              api: isAnthropic ? "anthropic-messages" : "openai-responses",
              apiKey: "$AI_GATEWAY_API_KEY",
              models: [modelEntry],
            },
          },
        }),
      );
    }
  }

  const eventsPath = join(logsDir, "pi.jsonl");
  const proc = await runProcess({
    cmd: process.execPath,
    args: [
      piBin,
      "-p",
      "--mode",
      "json",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--provider",
      provider,
      "--model",
      modelId,
      "--thinking",
      REASONING_TO_PI[reasoning] ?? "high",
    ],
    cwd: workdir,
    env,
    stdinText: instruction,
    stdoutPath: eventsPath,
    stderrPath: join(logsDir, "pi.stderr.txt"),
    timeoutMs,
  });
  const parsed = parsePiJsonl(await readFile(eventsPath, "utf8").catch(() => ""));
  return makeOutcome({
    ...proc,
    parsed,
    failedExtra: parsed.failedByStopReason,
    error: parsed.failedByStopReason ? parsed.lastAssistantError : undefined,
  });
}

async function runOpencode({
  installDir,
  logsDir,
  workdir,
  rawModel,
  reasoning,
  instruction,
  timeoutMs,
}) {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) throw new Error("AI_GATEWAY_API_KEY is required");

  const anthropicMatch = /^anthropic\/([^/]+)$/u.exec(rawModel);
  const mappedModel = anthropicMatch
    ? `anthropic/${anthropicMatch[1].replaceAll(".", "-")}`
    : `vercel/${rawModel}`;
  const modelFlag = reasoning ? `${mappedModel}#${reasoning}` : mappedModel;

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
    `${JSON.stringify(buildOpencodeConfig(rawModel), null, 2)}\n`,
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
  const ocBin = join(installDir, "arch/opencode");
  const eventsPath = join(logsDir, "events.ndjson");
  const proc = await runProcess({
    cmd: ocBin,
    args: ["run", "--standalone", "--format", "json", "--auto", "--thinking", "-m", modelFlag],
    cwd: workdir,
    env,
    stdinText: instruction,
    stdoutPath: eventsPath,
    stderrPath: join(logsDir, "opencode.stderr.txt"),
    timeoutMs,
  });

  const raw = await readFile(eventsPath, "utf8").catch(() => "");
  const initial = parseOpencodeEvents(raw, null);
  let exportedMessages = null;
  if (initial.sessionId) {
    try {
      const { stdout } = await execFileAsync(
        ocBin,
        ["session", "export", "--standalone", initial.sessionId],
        { cwd: workdir, env, maxBuffer: 32 * 1024 * 1024, timeout: 30_000 },
      );
      const exported = JSON.parse(stdout);
      if (Array.isArray(exported?.messages)) exportedMessages = exported.messages;
    } catch {}
  }
  const parsed = exportedMessages ? parseOpencodeEvents(raw, exportedMessages) : initial;
  return makeOutcome({ ...proc, parsed });
}

async function runFx({
  installDir,
  logsDir,
  workdir,
  rawModel,
  reasoning,
  instruction,
  timeoutMs,
}) {
  const env = { ...process.env, FX_PROVIDER: "gateway", FX_AUTO_UPGRADE: "0" };
  delete env.VERCEL_OIDC_TOKEN;
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;

  const outPath = join(logsDir, "fx.json");
  const proc = await runProcess({
    cmd: join(installDir, "arch/fx"),
    args: [
      "ask",
      "--json",
      "--no-save",
      "--full-access",
      "--model",
      rawModel,
      "--effort",
      reasoning,
    ],
    cwd: workdir,
    env,
    stdinText: instruction,
    stdoutPath: outPath,
    stderrPath: join(logsDir, "fx.stderr.txt"),
    timeoutMs,
  });
  const parsed = parseFxOutput(await readFile(outPath, "utf8").catch(() => ""));
  return makeOutcome({ ...proc, parsed });
}

const RUNNERS = { pi: runPi, opencode: runOpencode, fx: runFx };

async function main() {
  const harness = process.env.CODE_BENCH_HARNESS;
  const run = RUNNERS[harness];
  if (!run) throw new Error(`Unsupported peer harness: ${harness}`);

  const logsDir = process.env.CODE_BENCH_LOGS_DIR || "/logs/agent";
  await mkdir(logsDir, { recursive: true });
  const startedAt = Date.now();
  const outcome = await run({
    installDir: process.env.CODE_BENCH_INSTALL_DIR || "/installed-agent",
    logsDir,
    workdir: process.env.CODE_BENCH_TASK_WORKDIR || "/app",
    rawModel: process.env.CODE_BENCH_MODEL || "",
    reasoning: process.env.CODE_BENCH_REASONING || "high",
    instruction: await readFile(
      process.env.CODE_BENCH_INSTRUCTION || "/task/instruction.md",
      "utf8",
    ),
    timeoutMs: Number(process.env.CODE_BENCH_TIMEOUT_MS || "1200000"),
  });
  await writeFile(
    join(logsDir, "result.json"),
    `${JSON.stringify({ ...outcome, durationMs: Date.now() - startedAt }, null, 2)}\n`,
  );
  process.exit(outcome.exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
