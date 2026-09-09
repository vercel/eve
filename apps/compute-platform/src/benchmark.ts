import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

import { ComputeClient } from "eve/internal/compute-platform";

import { computePlatformConfig, requireComputeToken } from "./config.ts";

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

const client = new ComputeClient({
  endpoint: computePlatformConfig.endpoint,
  namespaceId: computePlatformConfig.namespaceId,
  token: requireComputeToken(),
});

const runId = randomUUID();
const timings: number[] = [];
for (let index = 0; index < 200; index++) {
  const start = performance.now();
  await client.send(
    { definition: "dev/counter", key: `benchmark-${runId}` },
    { version: 1, value: { value: 1 } },
    { idempotencyKey: `benchmark-${runId}-${index}` },
  );
  timings.push(performance.now() - start);
}
process.stdout.write(
  `${JSON.stringify({
    benchmark: "a2-durable-admission",
    iterations: timings.length,
    p50Ms: percentile(timings, 0.5),
    p95Ms: percentile(timings, 0.95),
    p99Ms: percentile(timings, 0.99),
  })}\n`,
);
