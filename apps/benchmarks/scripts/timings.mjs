#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  strict: true,
});

if (values.help || positionals.length !== 1) {
  console.log("Usage: node scripts/timings.mjs <run-directory-or-timings.json> [--json]");
  process.exit(values.help ? 0 : 1);
}

const timingsPath = resolveTimingsPath(positionals[0]);
const timings = JSON.parse(readFileSync(timingsPath, "utf8"));
if (!Array.isArray(timings)) throw new Error(`${timingsPath} must contain a timing array.`);

if (values.json) {
  console.log(JSON.stringify(timings, null, 2));
  process.exit(0);
}

const phases = timings.filter((timing) => timing.phase !== "run.context");
const width = Math.max(...phases.map((timing) => timing.phase.length));
for (const timing of phases) {
  const details = timing.details === undefined ? "" : ` ${JSON.stringify(timing.details)}`;
  console.log(
    `${timing.phase.padEnd(width)}  ${formatDuration(timing.durationMs).padStart(8)}  ${timing.outcome}${details}`,
  );
}

const byPhase = new Map(phases.map((timing) => [timing.phase, timing.durationMs]));
const setup = [
  "dependency-snapshot.get-or-create",
  "dependency-snapshot.publish",
  "subject-snapshot.get-or-create",
  "subject-snapshot.publish",
  "session.setup",
].reduce((total, phase) => total + (byPhase.get(phase) ?? 0), 0);
const agent = phases
  .filter((timing) => /^agent\.turn\.\d+$/u.test(timing.phase))
  .reduce((total, timing) => total + timing.durationMs, 0);
const validation = phases
  .filter((timing) => timing.phase.startsWith("validation."))
  .reduce((total, timing) => total + timing.durationMs, 0);
console.log(`\nSetup:      ${formatDuration(setup)}`);
console.log(`Agent:      ${formatDuration(agent)}`);
console.log(`Validation: ${formatDuration(validation)}`);
console.log(`Total:      ${formatDuration(byPhase.get("run.total") ?? 0)}`);

function resolveTimingsPath(input) {
  const path = resolve(input);
  if (path.endsWith(".json")) return path;
  const candidates = [
    join(path, "project/benchmark/timings.json"),
    join(dirname(path), "project/benchmark/timings.json"),
  ];
  const timingPath = candidates.find(existsSync);
  if (timingPath === undefined) {
    throw new Error(`Could not find project/benchmark/timings.json under ${path}.`);
  }
  return timingPath;
}

function formatDuration(durationMs) {
  return `${(durationMs / 1000).toFixed(1)}s`;
}
