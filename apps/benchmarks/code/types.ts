export type DatasetName = "deepswe-lean" | "swe-lean";

export type HarnessName = "eve-code" | "opencode" | "pi" | "fx";

export type ExecutionMode = "local" | "vercel-sandbox";

export type LinuxArch = "x64" | "arm64";

export interface CollectHook {
  readonly command: string;
  readonly timeoutSec: number;
}

export interface TaskSpec {
  readonly name: string;
  readonly dataset: DatasetName;
  readonly dir: string;
  readonly instructionPath: string;
  readonly testsDir: string;
  readonly environmentDir: string;
  readonly dockerImage?: string;
  readonly agentTimeoutSec: number;
  readonly verifierTimeoutSec: number;
  readonly separateVerifier: boolean;
  readonly cpus: number;
  readonly memoryMb: number;
  readonly env: Readonly<Record<string, string>>;
  readonly collectHooks: readonly CollectHook[];
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly costUsd?: number;
}

export interface TrialOverhead {
  readonly firstStepInputTokens?: number;
  readonly modelSteps?: number;
  readonly toolCalls?: number | Readonly<Record<string, number>>;
}

export interface AgentOutcome {
  readonly status: "completed" | "failed" | "timeout";
  readonly exitCode: number;
  readonly durationMs: number;
}

export interface VerifierOutcome {
  readonly status: "completed" | "failed" | "timeout" | "skipped";
  readonly exitCode: number;
  readonly durationMs: number;
}

export interface TrialResult {
  readonly task: string;
  readonly attempt: number;
  readonly harness: HarnessName;
  readonly model: string;
  readonly reward: number | null;
  readonly agent: AgentOutcome;
  readonly verifier: VerifierOutcome;
  readonly usage?: TokenUsage;
  readonly overhead?: TrialOverhead;
  readonly error?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface HarnessBundle {
  readonly harness: HarnessName;
  readonly version: string;
  readonly dir?: string;
  readonly archDirs?: Readonly<Record<LinuxArch, string>>;
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
  readonly reasoning: string;
  readonly attempts: number;
  readonly concurrency: number;
  readonly execution: ExecutionMode;
  readonly outputDir: string;
  readonly taskFilter?: string;
  readonly sourceSha?: string;
  readonly runUrl?: string;
}

export interface PrebuiltBundleEntry {
  readonly harness: HarnessName;
  readonly version: string;
  readonly bundleRelDir?: string;
  readonly archRelDirs?: Partial<Record<LinuxArch, string>>;
}

export interface PrebuiltBundleManifest {
  readonly nodeRelDirs: Partial<Record<LinuxArch, string>>;
  readonly bundles: Partial<Record<HarnessName, PrebuiltBundleEntry>>;
}

export const SUPPORTED_HARNESSES: readonly HarnessName[] = ["eve-code", "opencode", "pi", "fx"];
export const SUPPORTED_DATASETS: readonly DatasetName[] = ["swe-lean", "deepswe-lean"];
