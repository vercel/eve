import { join } from "node:path";

import type { BenchmarkRunOptions, HarnessName, TaskSpec, TrialResult } from "./types.ts";

const CREDENTIAL_ENV_VARS = [
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;

export function forwardCredentials(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of CREDENTIAL_ENV_VARS) {
    const val = process.env[key];
    if (val) out[key] = val;
  }
  return out;
}

export interface TrialJob {
  readonly harness: HarnessName;
  readonly task: TaskSpec;
  readonly attempt: number;
  readonly trialDir: string;
}

export async function runTrialPool(options: {
  readonly runOptions: BenchmarkRunOptions;
  readonly tasks: readonly TaskSpec[];
  readonly execute: (job: TrialJob) => Promise<TrialResult>;
  readonly onTrialComplete?: (completed: readonly TrialResult[]) => Promise<void>;
}): Promise<TrialResult[]> {
  const { runOptions, tasks, execute, onTrialComplete } = options;
  const jobs: TrialJob[] = [];
  for (const harness of runOptions.harnesses) {
    for (const task of tasks) {
      for (let attempt = 1; attempt <= runOptions.attempts; attempt += 1) {
        jobs.push({
          harness,
          task,
          attempt,
          trialDir: join(runOptions.outputDir, "trials", harness, task.name, String(attempt)),
        });
      }
    }
  }

  const results: TrialResult[] = [];
  let nextIdx = 0;
  let completed = 0;

  const worker = async () => {
    while (true) {
      const idx = nextIdx;
      nextIdx += 1;
      if (idx >= jobs.length) return;
      const job = jobs[idx]!;
      const result = await execute(job);
      results.push(result);
      completed += 1;
      const mark =
        result.reward === 1
          ? "resolved"
          : result.reward !== null
            ? `reward ${result.reward}`
            : `error (${result.error ?? result.agent.status})`;
      console.log(
        `[${completed}/${jobs.length}] ${job.harness}/${job.task.name}#${job.attempt}  ${mark}  ${Math.round(result.agent.durationMs / 1000)}s`,
      );
      if (onTrialComplete) {
        await onTrialComplete(results).catch(() => {});
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(runOptions.concurrency, jobs.length) }, () => worker()),
  );
  return results;
}
