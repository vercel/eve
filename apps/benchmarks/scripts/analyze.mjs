#!/usr/bin/env node

// Reads a benchmark results directory and reports, per case, the signals that
// matter when tuning the generated AGENTS.md and the shipped docs: outcome,
// agent cost, which docs pages the agent opened, and which grader assertions
// failed. Docs reads are recovered from shell commands because agents read
// `node_modules/eve/docs` with `cat`/`sed`/`grep` rather than a read tool.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

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
  --docs       Aggregate docs-page reads across cases instead of per-case detail.
  --json       Emit the collected records as JSON.`);
  process.exit(0);
}

const resultsRoot = resolve(import.meta.dirname, "../results");
const target =
  positionals[0] === undefined ? newestTimestamp(resultsRoot) : resolve(positionals[0]);
const runs = collectRuns(target);
if (runs.length === 0) throw new Error(`No benchmark runs found under ${target}.`);

const records = runs.map((run) => analyzeRun(run));
if (values.json) console.log(JSON.stringify(records, null, 2));
else if (values.docs) reportDocs(records);
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
  const raw = readRawTranscript(join(runPath, "transcript-raw.jsonl"));
  const timings = readTimings(runPath);
  const toolCalls = raw.flatMap((entry) => entry.toolCalls);
  const commands = toolCalls.flatMap((call) => (call.command === undefined ? [] : [call.command]));
  const usage = raw.reduce(
    (total, entry) => ({
      inputTokens: total.inputTokens + (entry.usage?.inputTokens ?? 0),
      outputTokens: total.outputTokens + (entry.usage?.outputTokens ?? 0),
      reasoningTokens: total.reasoningTokens + (entry.usage?.reasoningTokens ?? 0),
      cachedInputTokens: total.cachedInputTokens + (entry.usage?.cachedInputTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 },
  );
  return {
    case: basename(resolve(runPath, "..")),
    run: basename(runPath),
    path: runPath,
    status: result.status,
    durationSeconds: round(result.duration),
    agentSeconds: round(sumPhases(timings, /^agent\.turn\.\d+$/) / 1000),
    setupSeconds: round(sumPhases(timings, /^(subject|session)\./) / 1000),
    turns: raw.filter((entry) => entry.role === "user").length,
    toolCalls: toolCalls.length,
    commands: commands.length,
    usage,
    docsRead: docsPages(commands, toolCalls),
    agentsMdRead: commands.some((command) => /\bAGENTS\.md\b/.test(command)),
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

// Recovers `docs/<page>` paths from any tool input that mentions them, so a
// `cat`, `sed -n`, `grep -r`, or read-tool path all count as one read each.
function docsPages(commands, toolCalls) {
  const texts = [...commands, ...toolCalls.flatMap((call) => call.paths)];
  const counts = new Map();
  for (const text of texts) {
    for (const match of text.matchAll(/eve\/docs\/([\w./-]*\.mdx?)/g)) {
      const page = match[1];
      counts.set(page, (counts.get(page) ?? 0) + 1);
    }
    // A bare directory listing or a glob read counts as a directory probe.
    for (const match of text.matchAll(/eve\/docs\/([\w/-]+)\/(?:\*|$|\s)/g)) {
      const page = `${match[1]}/*`;
      counts.set(page, (counts.get(page) ?? 0) + 1);
    }
  }
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
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

function readRawTranscript(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const entry = JSON.parse(line);
      const content = entry.message?.content;
      const blocks = Array.isArray(content) ? content : [];
      return {
        role: entry.type,
        usage: entry.message?.usage,
        toolCalls: blocks
          .filter((block) => block.type === "tool_use")
          .map((block) => ({
            name: block.name,
            command: typeof block.input?.command === "string" ? block.input.command : undefined,
            paths: [block.input?.filePath, block.input?.path, block.input?.pattern].filter(
              (value) => typeof value === "string",
            ),
          })),
      };
    });
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
      `      turns=${record.turns} tools=${record.toolCalls} in=${record.usage.inputTokens} out=${record.usage.outputTokens} reasoning=${record.usage.reasoningTokens} registry=${record.registryCalls} agentsMd=${record.agentsMdRead}`,
    );
    const docs = Object.entries(record.docsRead);
    console.log(
      `      docs: ${docs.length === 0 ? "(none)" : docs.map(([page, count]) => (count > 1 ? `${page}×${count}` : page)).join(", ")}`,
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

function reportDocs(records) {
  const totals = new Map();
  for (const record of records) {
    for (const [page, count] of Object.entries(record.docsRead)) {
      const entry = totals.get(page) ?? { reads: 0, cases: new Set() };
      entry.reads += count;
      entry.cases.add(record.case);
      totals.set(page, entry);
    }
  }
  const rows = [...totals].sort((a, b) => b[1].reads - a[1].reads || a[0].localeCompare(b[0]));
  console.log("reads  cases  page");
  for (const [page, entry] of rows) {
    console.log(
      `${String(entry.reads).padStart(5)}  ${String(entry.cases.size).padStart(5)}  ${page}`,
    );
    console.log(`                 ${[...entry.cases].sort().join(", ")}`);
  }
}
