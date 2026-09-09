import { performance } from "node:perf_hooks";

import { assertComputeSchemaReady, createPostgresStorage } from "eve/internal/compute-platform";

import { computePlatformConfig } from "./config.ts";

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

const storage = createPostgresStorage({
  applicationName: "eve-compute-a1-benchmark",
  connectionString: computePlatformConfig.runtimeUrl,
  maxConnections: 1,
});

try {
  await assertComputeSchemaReady(storage);
  const timings: number[] = [];
  for (let index = 0; index < 200; index++) {
    const start = performance.now();
    await storage.query("SELECT 1");
    timings.push(performance.now() - start);
  }
  process.stdout.write(
    `${JSON.stringify({
      benchmark: "a1-storage-round-trip",
      iterations: timings.length,
      p50Ms: percentile(timings, 0.5),
      p95Ms: percentile(timings, 0.95),
      p99Ms: percentile(timings, 0.99),
    })}\n`,
  );
} finally {
  await storage.close();
}
