import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, loadavg, platform, release } from "node:os";
import { join } from "node:path";

import type { BenchConfig, HostBenchResult } from "./bench.js";
import type { Summary } from "./stats.js";

export interface BenchReport {
  readonly meta: {
    readonly timestamp: string;
    readonly node: string;
    readonly platform: string;
    readonly cpu: string;
    readonly cpus: number;
    /** 1, 5 and 15 minute load averages as the report was written: other work skews times. */
    readonly loadavg: readonly number[];
    readonly sessionEventChecks: boolean;
    readonly config: BenchConfig;
    readonly note: string;
  };
  readonly hosts: Record<string, HostBenchResult>;
}

export function createReport(
  config: BenchConfig,
  hosts: Record<string, HostBenchResult>,
  sessionEventChecks: boolean,
): BenchReport {
  return {
    meta: {
      timestamp: new Date().toISOString(),
      node: process.version,
      platform: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model ?? "unknown",
      cpus: cpus().length,
      loadavg: loadavg().map((load) => Math.round(load * 100) / 100),
      sessionEventChecks,
      config,
      note:
        "Mock model with zero latency; milliseconds from the client's send. The workflow host runs " +
        "Workflow's local World in this process, not Vercel's.",
    },
    hosts,
  };
}

/** Writes `report` as `host-bench-<timestamp>.json` under `directory` and returns its path. */
export function writeReport(report: BenchReport, directory: string): string {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `host-bench-${report.meta.timestamp.replaceAll(":", "-")}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

/** The rows the table shows: scenario, metric. Counts appear when any host reports them. */
const ROWS: readonly (readonly [string, string])[] = [
  ["first-turn", "sendMs"],
  ["first-turn", "firstDeltaMs"],
  ["first-turn", "settledMs"],
  ["follow-up", "firstDeltaMs"],
  ["follow-up", "settledMs"],
];

const COUNT_KEYS = [
  "events",
  "tailMs",
  "tailReadMs",
  "world.queue.messages",
  "world.events.written",
  "world.event.step_started",
  "world.events.listed",
  "world.events.write.ms",
  "world.streams.get.ms",
  "world.streams.write.ms",
  "world.queue.ms",
];

function cell(value: Summary | number | undefined): string {
  if (value === undefined) return "-";
  if (typeof value === "number") return Number.isNaN(value) ? "-" : String(value);
  return value.median === value.p90 ? String(value.median) : `${value.median} / ${value.p90}`;
}

/** A compact plain-text table: one row per scenario metric, one column per host (median / p90). */
export function formatTable(report: BenchReport): string {
  const hosts = Object.keys(report.hosts);
  const scenarios = (host: string) => report.hosts[host]!.scenarios;
  const rows: string[][] = [];
  const add = (scenario: string, metric: string) => {
    const values = hosts.map((host) => scenarios(host)[scenario]?.[metric]);
    if (values.every((value) => value === undefined)) return;
    rows.push([scenario, metric, ...values.map(cell)]);
  };
  for (const [scenario, metric] of ROWS) add(scenario, metric);
  const first = scenarios(hosts[0]!);
  for (const scenario of Object.keys(first).filter((key) => key.startsWith("tools-"))) {
    for (const metric of ["settledMs", "stepGapMs", "stepGapGrowthMs", "perStepMs"])
      add(scenario, metric);
    for (const metric of COUNT_KEYS) add(scenario, metric);
  }
  const checkpoints = Object.keys(first["history"] ?? {})
    .map((key) => /^k(\d+)\./u.exec(key)?.[1])
    .filter((k): k is string => k !== undefined);
  for (const k of [...new Set(checkpoints)].sort((a, b) => Number(a) - Number(b))) {
    for (const metric of ["firstDeltaMs", "settledMs", ...COUNT_KEYS])
      add("history", `k${k}.${metric}`);
  }
  add("history", "settledMsPerPriorTurn");
  for (const metric of COUNT_KEYS) add("follow-up", metric);

  const header = ["scenario", "metric", ...hosts.map((host) => `${host} (p50 / p90)`)];
  const widths = header.map((_, column) =>
    Math.max(...[header, ...rows].map((row) => row[column]!.length)),
  );
  const line = (row: readonly string[]) =>
    row.map((value, column) => value.padEnd(widths[column]!)).join("  ");
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join(
    "\n",
  );
}
