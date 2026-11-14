import { join } from "node:path";

import { afterAll, beforeAll, describe, it, vi } from "vitest";

import { resolvePackageRoot } from "#internal/application/package.js";

import { runHostBench, type BenchConfig, type HostBenchResult } from "./bench.js";
import { BENCH_HOSTS } from "./hosts.js";
import { createReport, formatTable, writeReport } from "./report.js";

// The host bench, which only runs when asked: `EVE_HOST_BENCH=1`. It measures each host's
// session costs with a zero-latency model and writes a JSON report; see `bench.ts`.
//
//   EVE_HOST_BENCH=1 pnpm exec vitest run --config vitest.integration.config.ts \
//     src/internal/testing/host-bench/host-bench.integration.test.ts
//
// EVE_HOST_BENCH_HOSTS          hosts to run, comma-separated (default: every BENCH_HOSTS entry)
// EVE_HOST_BENCH_ITERATIONS     measured iterations per scenario (default 7)
// EVE_HOST_BENCH_WARMUP         discarded iterations per scenario (default 2)
// EVE_HOST_BENCH_TOOLS          sequential tool calls per tool scenario (default 1,5,20)
// EVE_HOST_BENCH_HISTORY        prior turns at which the history scenario reports (default 0,1,10,50)
// EVE_HOST_BENCH_HISTORY_ITERATIONS  history sessions (default 3)
// EVE_HOST_BENCH_CHECKS=1       keep the dev-only session event checks on (off by default, as in production)
// EVE_HOST_BENCH_OUT            report directory (default: <package>/benchmark-results)

const env = process.env;
const enabled = env.EVE_HOST_BENCH === "1";

const numbers = (value: string | undefined, fallback: readonly number[]) =>
  value === undefined || value === "" ? fallback : value.split(",").map((part) => Number(part));

const config: BenchConfig = {
  iterations: Number(env.EVE_HOST_BENCH_ITERATIONS ?? 7),
  warmup: Number(env.EVE_HOST_BENCH_WARMUP ?? 2),
  toolCounts: numbers(env.EVE_HOST_BENCH_TOOLS, [1, 5, 20]),
  historyTurns: numbers(env.EVE_HOST_BENCH_HISTORY, [0, 1, 10, 50]),
  historyIterations: Number(env.EVE_HOST_BENCH_HISTORY_ITERATIONS ?? 3),
};
const checks = env.EVE_HOST_BENCH_CHECKS === "1";
const hosts = env.EVE_HOST_BENCH_HOSTS?.split(",") ?? Object.keys(BENCH_HOSTS);

describe.skipIf(!enabled)("host bench", () => {
  const results: Record<string, HostBenchResult> = {};

  beforeAll(() => {
    vi.stubEnv("EVE_CHECK_SESSION_EVENTS", checks ? "1" : "0");
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    if (Object.keys(results).length === 0) return;
    const report = createReport(config, results, checks);
    const file = writeReport(
      report,
      env.EVE_HOST_BENCH_OUT ?? join(resolvePackageRoot(), "benchmark-results"),
    );
    process.stdout.write(`\n${formatTable(report)}\n\nhost bench report: ${file}\n`);
  });

  for (const name of hosts) {
    it(
      name,
      async () => {
        const host = BENCH_HOSTS[name];
        if (host === undefined)
          throw new Error(
            `No bench host "${name}". Hosts: ${Object.keys(BENCH_HOSTS).join(", ")}.`,
          );
        results[name] = await runHostBench(name, host, config, (line) =>
          process.stdout.write(`[host-bench] ${line}\n`),
        );
      },
      3_600_000,
    );
  }
});
