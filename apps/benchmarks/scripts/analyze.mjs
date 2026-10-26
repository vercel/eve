#!/usr/bin/env node

// Reads a benchmark results directory and reports, per case, the signals that
// matter when tuning the generated AGENTS.md and the shipped docs: outcome,
// agent cost, which docs pages the agent opened, and which grader assertions
// failed. Turns and tool calls come from agent-eval's harness-neutral
// `transcript.json`, and token usage from the raw transcript via the same
// harness-aware parser as published results, so every metric is read the same
// way for Claude Code, Codex, and OpenCode.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { extractRunUsage } from "./cost.mjs";
import {
  docsCounts,
  docsSequence,
  docsUsage,
  readTranscript,
  shippedDocsPages,
  transcriptToolCalls,
} from "./docs-reads.mjs";

// agent-eval names agents `<provider>/<harness>`; cost.mjs keys on display names.
const harnessNames = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode" };

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { json: { type: "boolean" }, docs: { type: "boolean" }, help: { type: "boolean" } },
  strict: true,
});

if (values.help) {
  console.log(`Usage:
  node scripts/analyze.mjs [results-dir] [--docs] [--json]

  results-dir  A run directory, a case directory, a timestamp directory, or a
               treatment directory. Defaults to the newest timestamp directory.
  --docs       Aggregate docs-page reads across runs, including shipped pages
               that no run opened, instead of per-case detail.
  --json       Emit the collected records (or, with --docs, the aggregate) as JSON.`);
  process.exit(0);
}

const resultsRoot = resolve(import.meta.dirname, "../results");
const docsRoot = resolve(import.meta.dirname, "../../../docs");
const target =
  positionals[0] === undefined ? newestTimestamp(resultsRoot) : resolve(positionals[0]);
const runs = collectRuns(target);
if (runs.length === 0) throw new Error(`No benchmark runs found under ${target}.`);

const records = runs.map((run) => analyzeRun(run));
if (values.docs) {
  const usage = docsUsage(records, shippedDocsPages(docsRoot));
  if (values.json) console.log(JSON.stringify(usage, null, 2));
  else reportDocs(usage);
} else if (values.json) console.log(JSON.stringify(records, null, 2));
else reportRuns(records, target);

function newestTimestamp(root) {
  const treatments = directories(root);
  const stamps = treatments.flatMap((treatment) =>
    directories(treatment).map((path) => ({ path, name: basename(path) })),
  );
  if (stamps.length === 0) throw new Error(`No results under ${root}.`);
  stamps.sort((a, b) => a.name.localeCompare(b.name));
  return stamps.at(-1).path;
}

function directories(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
}

// Accepts any depth: run dir, case dir, timestamp dir, or treatment dir.
function collectRuns(root) {
  if (existsSync(join(root, "result.json"))) return [root];
  return directories(root)
    .flatMap((child) => collectRuns(child))
    .sort();
}

function analyzeRun(runPath) {
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
    agentSeconds: round(sumPhases(timings, /^agent\.turn\.\d+$/) / 1000),
    setupSeconds: round(sumPhases(timings, /^(subject|session)\./) / 1000),
    // `null` when the transcript is missing or has no usage events, so an
    // unreadable run never reports as zero turns or zero tokens.
    turns: transcript?.summary?.totalTurns ?? null,
    toolCalls: toolCalls.length,
    commands: commands.length,
    usage: extractRunUsage(raw, harness),
    docsRead: docsCounts(docsSequence(toolCalls)),
    // Which page the agent opened first. `README.md` means the routing index did
    // its job; anything else means the agent guessed or searched its way in.
    docsEntry: docsSequence(toolCalls)[0] ?? "(none)",
    registryCalls: commands.filter((command) => /\beve\s+(registry|add)\b/.test(command)).length,
    failedCommands: failedCommands(commands),
    stalls: timings
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
  return existsSync(path) ? readJson(path) : [];
}

function sumPhases(timings, pattern) {
  return timings
    .filter((entry) => pattern.test(entry.phase))
    .reduce((total, entry) => total + entry.durationMs, 0);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function round(value) {
  return typeof value === "number" ? Math.round(value * 10) / 10 : 0;
}

function reportRuns(records, target) {
  console.log(`# ${target}\n`);
  for (const record of records) {
    const mark = record.status === "passed" ? "PASS" : "FAIL";
    console.log(
      `${mark}  ${record.case} ${record.run}  ${record.durationSeconds}s total / ${record.agentSeconds}s agent / ${record.setupSeconds}s setup`,
    );
    console.log(
      `      turns=${record.turns ?? "n/a"} tools=${record.toolCalls} ${formatUsage(record.usage)} registry=${record.registryCalls}`,
    );
    const docs = Object.entries(record.docsRead);
    console.log(
      `      docs: entered at ${record.docsEntry}${docs.length === 0 ? "" : ` — ${docs.map(([page, count]) => (count > 1 ? `${page}×${count}` : page)).join(", ")}`}`,
    );
    for (const stall of record.stalls) console.log(`      ! ${stall}`);
    for (const failure of record.failures) console.log(`      ! ${failure}`);
    for (const script of record.scriptFailures) console.log(`      ! script ${script}`);
    const repeats = record.failedCommands.filter((entry) => entry.count > 2);
    for (const repeat of repeats.slice(0, 3)) {
      console.log(`      ~ repeated ×${repeat.count}: ${repeat.command.slice(0, 100)}`);
    }
    console.log("");
  }
  const passed = records.filter((record) => record.status === "passed").length;
  console.log(`${passed}/${records.length} passed`);
}

function formatUsage(usage) {
  if (usage === null) return "tokens=n/a";
  return `in=${usage.input} out=${usage.output} reasoning=${usage.reasoning} cache-read=${usage.cacheRead}`;
}

function reportDocs(usage) {
  console.log(`${usage.runsWithDocs}/${usage.runs} runs opened at least one docs page\n`);
  console.log(" runs  reads  cases  page");
  for (const entry of usage.pages) {
    console.log(
      `${String(entry.runs).padStart(5)}  ${String(entry.reads).padStart(5)}  ${String(entry.cases.length).padStart(5)}  ${entry.page}`,
    );
    console.log(`                      ${entry.cases.join(", ")}`);
  }
  console.log(`\nNever opened (${usage.unread.length} shipped pages):`);
  for (const page of usage.unread) console.log(`  ${page}`);
}
