import { z } from "zod";
import { browserActivityKinds } from "../../web/browser/activity.ts";

const dateTime = z.iso.datetime();
const nullableDateTime = dateTime.nullable();

const benchmarkSessionSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["root", "worker"]),
  traceId: z.string().min(1).nullable(),
});

const liveBenchmarkTaskSchema = z.object({
  activity: z.string().min(1).nullable().default(null),
  activityDurationsMs: z
    .partialRecord(z.enum(browserActivityKinds), z.number().int().nonnegative())
    .default({}),
  browserLiveViewUrl: z.url().nullable().default(null),
  completedAt: nullableDateTime,
  costComplete: z.boolean(),
  costUsd: z.number().nonnegative().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  error: z.string().nullable(),
  id: z.string().min(1),
  judgeRationale: z.string().nullable().default(null),
  judgeScore: z.number().min(0).max(1).nullable().default(null),
  name: z.string().min(1),
  sessions: z.array(benchmarkSessionSchema),
  startedAt: nullableDateTime,
  status: z.enum([
    "pending",
    "running",
    "passed",
    "failed",
    "scored",
    "skipped",
  ]),
  success: z.boolean().nullable(),
  terminalMessage: z.string().nullable(),
  toolCalls: z.record(z.string(), z.number().int().nonnegative()),
  verdict: z.enum(["passed", "failed", "scored", "skipped"]).nullable(),
});

const liveBenchmarkVariantSchema = z.object({
  completedAt: nullableDateTime,
  error: z.string().nullable(),
  kind: z.enum(["baseline", "candidate"]),
  ref: z.string().min(1),
  sha: z.string().regex(/^[0-9a-f]{40}$/u),
  startedAt: nullableDateTime,
  status: z.enum(["pending", "preparing", "running", "completed", "failed"]),
  tasks: z.array(liveBenchmarkTaskSchema),
  url: z.url(),
});

export const browserBenchmarkLiveStatusSchema = z.object({
  completedAt: nullableDateTime,
  error: z.string().nullable(),
  label: z.string().min(1).optional(),
  maxConcurrency: z.number().int().min(1),
  outputDirectory: z.string().min(1),
  repetitions: z.number().int().min(1),
  runId: z.string().min(1),
  startedAt: dateTime,
  status: z.enum(["preparing", "running", "completed", "failed"]),
  suite: z.enum(["all", "live", "profile", "smoke"]),
  taskTimeoutMs: z.number().int().positive(),
  updatedAt: dateTime,
  variants: z.object({
    baseline: liveBenchmarkVariantSchema,
    candidate: liveBenchmarkVariantSchema,
  }),
  version: z.literal(1),
});

export type BrowserBenchmarkLiveStatus = z.infer<
  typeof browserBenchmarkLiveStatusSchema
>;

export const browserBenchmarkRunListSchema = z.object({
  runs: z.array(browserBenchmarkLiveStatusSchema),
});
