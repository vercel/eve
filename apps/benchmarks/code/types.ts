export type DatasetName = "deepswe-lean" | "swe-lean";
export type HarnessName = "eve-code" | "opencode" | "pi" | "fx";
export type ReasoningLevel = "low" | "medium" | "high";
export type ExecutionMode = "local" | "vercel-sandbox";

export const SUPPORTED_DATASETS: readonly DatasetName[] = ["deepswe-lean", "swe-lean"];
export const SUPPORTED_HARNESSES: readonly HarnessName[] = ["eve-code", "opencode", "pi", "fx"];

export interface TaskCollectHook {
  readonly command: string;
  readonly timeoutSec: number;
}

export interface TaskSpec {
  readonly name: string;
  readonly dataset: DatasetName;
  readonly dir: string;
  readonly instruction: string;
  readonly dockerImage: string;
  readonly agentTimeoutSec: number;
  readonly verifierTimeoutSec: number;
  readonly separateVerifier: boolean;
  readonly collectHooks: readonly TaskCollectHook[];
  readonly artifacts: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cpus: number;
  readonly memoryMb: number;
}

export interface TrialUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly costUsd?: number;
}

export interface TrialOverhead {
  readonly firstStepInputTokens?: number;
  readonly modelSteps?: number;
  readonly toolCalls?: Readonly<Record<string, number>>;
}

export interface StepOutcome {
  readonly status: "completed" | "failed" | "timeout" | "skipped";
  readonly exitCode: number | null;
  readonly durationMs: number;
}

export interface TrialResult {
  readonly task: string;
  readonly attempt: number;
  readonly harness: HarnessName;
  readonly model: string;
  readonly reward: number | null;
  readonly agent: StepOutcome;
  readonly verifier: StepOutcome;
  readonly usage?: TrialUsage;
  readonly overhead?: TrialOverhead;
  readonly error?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface HarnessBundle {
  readonly harness: HarnessName;
  readonly version: string;
  readonly dir: string;
  readonly archDirs?: Readonly<Record<"x64" | "arm64", string>>;
  readonly command: (ctx: HarnessRunContext) => string;
  readonly env: (ctx: HarnessRunContext) => Record<string, string>;
}

export interface HarnessRunContext {
  readonly installDir: string;
  readonly instructionPath: string;
  readonly logsDir: string;
  readonly taskWorkdir: string;
  readonly model: string;
  readonly reasoning: ReasoningLevel;
  readonly agentTimeoutMs: number;
}

export interface ConfidenceInterval {
  readonly estimate: number;
  readonly low: number;
  readonly high: number;
}

export interface HarnessScore {
  readonly contender: HarnessName;
  readonly version: string;
  readonly resolved: number;
  readonly attempts: number;
  readonly incomplete: number;
  readonly resolveRate: ConfidenceInterval;
  readonly costUsd: number | null;
  readonly costPerResolvedUsd: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedShare: number | null;
  readonly latencyP50Ms: number;
  readonly latencyP90Ms: number;
  readonly medianSteps: number | null;
}

export interface BenchmarkRunOptions {
  readonly dataset: DatasetName;
  readonly harnesses: readonly HarnessName[];
  readonly model: string;
  readonly reasoning: ReasoningLevel;
  readonly attempts: number;
  readonly concurrency: number;
  readonly execution: ExecutionMode;
  readonly outputDir: string;
  readonly taskFilter?: string;
  readonly sourceSha?: string;
  readonly runUrl?: string;
  readonly vcpus?: number;
}

export type PrebuiltBundleManifest = Partial<
  Record<
    HarnessName,
    {
      readonly harness: HarnessName;
      readonly version: string;
      readonly bundleRelDir: string;
      readonly archRelDirs?: Readonly<{ readonly x64: string; readonly arm64: string }>;
    }
  >
>;
