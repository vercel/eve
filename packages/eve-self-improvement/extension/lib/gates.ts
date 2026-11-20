import { z } from "zod";
import type { Check, Cohort, Metric } from "./types.js";

const cohort = z.object({
  sampleSize: z.number().int().min(20),
  quality: z.number().min(0).max(1),
  correctionRate: z.number().min(0).max(1),
  failureRate: z.number().min(0).max(1),
  p95LatencyMs: z.number().positive(),
  costPerSessionUsd: z.number().nonnegative().optional(),
});
export function compareMetrics(before: Cohort, after: Cohort, target: string): Check {
  const a = cohort.safeParse(before),
    b = cohort.safeParse(after);
  if (!a.success || !b.success)
    return {
      name: "measured improvement",
      status: "unavailable",
      reason:
        "Need at least 20 real, comparable samples per cohort and all quality/reliability/latency measurements",
    };
  if (!["quality", "correctionRate", "failureRate", "p95LatencyMs"].includes(target))
    return {
      name: "measured improvement",
      status: "failed",
      reason: "Cost or token savings alone cannot qualify a candidate",
    };
  if (
    after.quality < before.quality ||
    after.correctionRate > before.correctionRate ||
    after.failureRate > before.failureRate ||
    after.p95LatencyMs > before.p95LatencyMs * 1.05
  )
    return {
      name: "measured improvement",
      status: "failed",
      reason: "Quality/reliability regressed or p95 latency rose more than 5%",
    };
  const field = target as "quality" | "correctionRate" | "failureRate" | "p95LatencyMs";
  const change = field === "quality" ? after[field] - before[field] : before[field] - after[field];
  const passed = before[field] > 0 && change / before[field] + 1e-12 >= 0.1;
  return {
    name: "measured improvement",
    status: passed ? "passed" : "failed",
    reason: passed
      ? "Target improved at least 10%; quality, reliability and latency gates passed"
      : "Target did not improve at least 10% from a nonzero baseline",
  };
}
export function allPassed(checks: Check[]): boolean {
  return checks.length > 0 && checks.every((c) => c.status === "passed");
}
export const metricPriority = (metric: Metric): number =>
  metric === "correction" ? 3 : metric === "failure" ? 2 : metric === "latency" ? 1 : 0;
