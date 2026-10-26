// Reads one agent-eval run directory (`<experiment>/<timestamp>/<case>/run-N`)
// into a record of the signals that matter when tuning the generated AGENTS.md
// and the shipped docs: outcome, agent cost, which docs pages the agent opened,
// and which grader assertions failed. Turns and tool calls come from
// agent-eval's harness-neutral `transcript.json`, and token usage from the raw
// transcript via the same harness-aware parser as published results, so every
// metric is read the same way for Claude Code, Codex, and OpenCode.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { extractRunUsage } from "./cost.mjs";
import { docsCounts, docsSequence, readTranscript, transcriptToolCalls } from "./docs-reads.mjs";

// agent-eval names agents `<provider>/<harness>`; cost.mjs keys on display names.
const harnessNames = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode" };

export function directories(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
}

// Accepts any depth: run dir, case dir, timestamp dir, or treatment dir.
export function collectRuns(root) {
  if (existsSync(join(root, "result.json"))) return [root];
  return directories(root)
    .flatMap((child) => collectRuns(child))
    .sort();
}

export function analyzeRun(runPath) {
  const result = readJson(join(runPath, "result.json"));
  const rawPath = join(runPath, "transcript-raw.jsonl");
  const raw = existsSync(rawPath) ? readFileSync(rawPath, "utf8") : "";
  const timings = readTimings(runPath);
  const transcript = readTranscript(runPath);
  const harness =
    harnessNames[
      String(transcript?.agent ?? "")
        .split("/")
        .at(-1)
    ];
  const toolCalls = transcriptToolCalls(transcript);
  const commands = toolCalls.flatMap((call) => (call.command === undefined ? [] : [call.command]));
  return {
    case: basename(resolve(runPath, "..")),
    run: basename(runPath),
    path: runPath,
    status: result.status,
    durationSeconds: round(result.duration),
    // Metrics are `null` when their source file is missing or unreadable, so
    // an unmeasured run never reports zero time, turns, or tokens.
    agentSeconds: phaseSeconds(timings, /^agent\.turn\.\d+$/),
    setupSeconds: phaseSeconds(timings, /^(subject|session)\./),
    turns: transcript?.summary?.totalTurns ?? null,
    toolCalls: toolCalls.length,
    commands: commands.length,
    usage: extractRunUsage(raw, harness),
    docsRead: docsCounts(docsSequence(toolCalls)),
    // Which page the agent opened first. `README.md` means the routing index did
    // its job; anything else means the agent guessed or searched its way in.
    docsEntry: docsSequence(toolCalls)[0] ?? null,
    registryCalls: commands.filter((command) => /\beve\s+(registry|add)\b/.test(command)).length,
    failedCommands: failedCommands(commands),
    stalls: (timings ?? [])
      .filter(
        (entry) => /^agent\.turn\.\d+\.summary$/.test(entry.phase) && entry.outcome !== "success",
      )
      .map((entry) => `${entry.phase}: ${entry.details?.stall ?? "did not finish"}`),
    failures: graderFailures(join(runPath, "outputs/eval.txt")),
    scriptFailures: scriptFailures(runPath),
  };
}

function failedCommands(commands) {
  // Cheap proxy for wasted effort: repeated identical commands and probes into
  // paths that the scaffold does not have.
  const seen = new Map();
  for (const command of commands) seen.set(command, (seen.get(command) ?? 0) + 1);
  return [...seen].filter(([, count]) => count > 1).map(([command, count]) => ({ command, count }));
}

function graderFailures(path) {
  if (!existsSync(path)) return [];
  const output = readFileSync(path, "utf8");
  const failures = [...output.matchAll(/^\s*(?:×|✕|FAIL)\s+(.+)$/gm)].map((match) =>
    match[1].trim(),
  );
  return [...new Set(failures)];
}

function scriptFailures(runPath) {
  const scripts = join(runPath, "outputs/scripts");
  if (!existsSync(scripts)) return [];
  return readdirSync(scripts)
    .filter((name) =>
      /error|not found|exit code [1-9]/i.test(readFileSync(join(scripts, name), "utf8")),
    )
    .map((name) => basename(name, ".txt"));
}

function readTimings(runPath) {
  const path = join(runPath, "project/benchmark/timings.json");
  return existsSync(path) ? readJson(path) : undefined;
}

function phaseSeconds(timings, pattern) {
  if (timings === undefined) return null;
  const ms = timings
    .filter((entry) => pattern.test(entry.phase))
    .reduce((total, entry) => total + entry.durationMs, 0);
  return round(ms / 1000);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function round(value) {
  return typeof value === "number" ? Math.round(value * 10) / 10 : null;
}
