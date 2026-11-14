import { z } from "zod";

const benchmarkTaskSchema = z.object({
  costComplete: z.boolean(),
  costUsd: z.number().nonnegative().nullable(),
  durationMs: z.number().nonnegative(),
  error: z.string().nullable(),
  evalDurationMs: z.number().nonnegative(),
  failedToolCalls: z.number().int().nonnegative().default(0),
  id: z.string(),
  inputTokens: z.number().int().nonnegative().nullable().default(null),
  judgeRationale: z.string().nullable().default(null),
  judgeScore: z.number().min(0).max(1).nullable().default(null),
  messageCount: z.number().int().nonnegative().default(0),
  modelSteps: z.number().int().nonnegative().default(0),
  name: z.string(),
  outputTokens: z.number().int().nonnegative().nullable().default(null),
  reasoningBlockCount: z.number().int().nonnegative().default(0),
  sessionId: z.string().nullable(),
  status: z.enum(["completed", "failed", "waiting"]),
  success: z.boolean(),
  terminalMessage: z.string(),
  toolCalls: z.record(z.string(), z.number().int().nonnegative()).default({}),
  verdict: z.enum(["passed", "failed", "scored", "skipped"]),
});

export const browserBenchmarkSchema = z.object({
  completedAt: z.iso.datetime(),
  gitSha: z.string().nullable(),
  label: z.string(),
  startedAt: z.iso.datetime(),
  summary: z.object({
    costComplete: z.boolean(),
    failed: z.number().int().nonnegative(),
    failedToolCalls: z.number().int().nonnegative().default(0),
    meanJudgeScore: z.number().min(0).max(1).nullable().default(null),
    medianDurationMs: z.number().nonnegative().nullable(),
    passed: z.number().int().nonnegative(),
    p95DurationMs: z.number().nonnegative().nullable(),
    successRate: z.number().min(0).max(1),
    totalInputTokens: z.number().int().nonnegative().nullable().default(null),
    totalModelSteps: z.number().int().nonnegative().default(0),
    totalOutputTokens: z.number().int().nonnegative().nullable().default(null),
    totalToolCalls: z.number().int().nonnegative().default(0),
    totalCostUsd: z.number().nonnegative().nullable(),
  }),
  target: z.object({
    kind: z.enum(["local", "remote"]),
    url: z.url(),
  }),
  tasks: z.array(benchmarkTaskSchema),
  version: z.literal(1),
});

export type BrowserBenchmark = z.infer<typeof browserBenchmarkSchema>;
