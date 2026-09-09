export type StepStatus = "completed" | "timeout" | "failed" | "skipped";

export interface StepResult {
  readonly status: StepStatus;
  readonly exitCode: number | null;
  readonly durationMs: number;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly costUsd: number;
}

export interface TrialResult {
  readonly task: string;
  readonly attempt: number;
  readonly harness: string;
  readonly model: string;
  readonly reward: number | null;
  readonly agent: StepResult;
  readonly verifier: StepResult;
  readonly usage?: Usage;
  readonly error?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface JobResult {
  readonly job: string;
  readonly dataset: { readonly name: string; readonly version: string; readonly commit: string };
  readonly harness: string;
  readonly model: string;
  readonly trials: readonly TrialResult[];
  readonly summary: JobSummary;
}

export interface JobSummary {
  readonly tasks: number;
  readonly attempts: number;
  readonly resolved: number;
  readonly meanReward: number;
}

export function summarize(trials: readonly TrialResult[]): JobSummary {
  const tasks = new Set(trials.map((trial) => trial.task)).size;
  const rewards = trials.map((trial) => trial.reward ?? 0);
  const resolved = rewards.filter((reward) => reward >= 1).length;
  const meanReward = rewards.length === 0 ? 0 : rewards.reduce((a, b) => a + b, 0) / rewards.length;
  return { tasks, attempts: trials.length, resolved, meanReward };
}
