export type StepStatus = "completed" | "timeout" | "failed" | "skipped";

export interface StepResult {
  readonly status: StepStatus;
  readonly exitCode: number | null;
  readonly durationMs: number;
}

/**
 * Root-session model usage as reported by the harness. `inputTokens` includes
 * cache reads and `outputTokens` includes reasoning, so harnesses that report
 * those separately are normalized to the same totals.
 */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  /** Null when the harness reported no cost (for example, no pricing data for a custom provider). */
  readonly costUsd: number | null;
}

/**
 * Where a trial broke before it could measure the harness:
 * - `environment`: runner-owned work (image, container, uploads, log download) failed.
 * - `harness`: the harness ran but completed no model call, so its adapter,
 *   credentials, or launch are broken rather than its task-solving.
 * - `verifier`: the verifier produced no reward.
 */
export type InvalidPhase = "environment" | "harness" | "verifier";

export interface InvalidTrial {
  readonly phase: InvalidPhase;
  readonly reason: string;
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
  /** Present when the trial is excluded from scoring. */
  readonly invalid?: InvalidTrial;
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
  /** Attempts that measured the harness; invalid attempts are excluded. */
  readonly scored: number;
  readonly invalid: Readonly<Record<InvalidPhase, number>>;
  readonly resolved: number;
  /** Mean reward over scored attempts; null when none were scored. */
  readonly meanReward: number | null;
}

const PHASES: readonly InvalidPhase[] = ["environment", "harness", "verifier"];

export function classifyTrial(
  trial: Pick<TrialResult, "agent" | "verifier" | "reward" | "usage" | "error">,
  modelFree: boolean,
): InvalidTrial | undefined {
  if (trial.error !== undefined) {
    return {
      phase: "environment",
      reason:
        trial.agent.status === "skipped"
          ? `trial setup failed before the harness started: ${trial.error}`
          : `runner failed after the harness started: ${trial.error}`,
    };
  }
  if (!modelFree && !reachedModel(trial.usage)) {
    return {
      phase: "harness",
      reason: trial.usage
        ? "harness reported zero token usage; no model call completed"
        : "harness reported no model usage; no model call completed",
    };
  }
  if (trial.reward === null) {
    return {
      phase: "verifier",
      reason:
        trial.verifier.status === "timeout"
          ? "verifier timed out without writing a reward"
          : "verifier wrote no reward",
    };
  }
  return undefined;
}

function reachedModel(usage: Usage | undefined): boolean {
  return usage !== undefined && (usage.inputTokens > 0 || usage.outputTokens > 0);
}

export function assertTrialResult(value: unknown): asserts value is TrialResult {
  if (!value || typeof value !== "object") throw new Error("trial record must be an object");
  const trial = value as Partial<TrialResult>;
  const step = (value: unknown) => {
    const item = value as Partial<StepResult> | undefined;
    return (
      item !== undefined &&
      ["completed", "timeout", "failed", "skipped"].includes(item.status ?? "") &&
      (item.exitCode === null || Number.isInteger(item.exitCode)) &&
      typeof item.durationMs === "number" &&
      Number.isFinite(item.durationMs)
    );
  };
  const invalid = trial.invalid as Partial<InvalidTrial> | undefined;
  if (
    typeof trial.task !== "string" ||
    !Number.isInteger(trial.attempt) ||
    typeof trial.harness !== "string" ||
    typeof trial.model !== "string" ||
    !(
      trial.reward === null ||
      (typeof trial.reward === "number" && Number.isFinite(trial.reward))
    ) ||
    !step(trial.agent) ||
    !step(trial.verifier) ||
    (invalid !== undefined &&
      (!PHASES.includes(invalid.phase as InvalidPhase) || typeof invalid.reason !== "string")) ||
    typeof trial.startedAt !== "string" ||
    typeof trial.finishedAt !== "string"
  ) {
    throw new Error("trial record has an invalid shape");
  }
}

export function summarize(trials: readonly TrialResult[]): JobSummary {
  const tasks = new Set(trials.map((trial) => trial.task)).size;
  const invalid = { environment: 0, harness: 0, verifier: 0 };
  const scored: number[] = [];
  for (const trial of trials) {
    if (trial.invalid) invalid[trial.invalid.phase]++;
    else scored.push(trial.reward ?? 0);
  }
  return {
    tasks,
    attempts: trials.length,
    scored: scored.length,
    invalid,
    resolved: scored.filter((reward) => reward >= 1).length,
    meanReward: scored.length === 0 ? null : scored.reduce((a, b) => a + b, 0) / scored.length,
  };
}
