import type { EveEval, EveEvalResult, EveEvalRunSummary, EveEvalTarget } from "#evals/types.js";
import { resolveLocalGitMetadata } from "#evals/runner/resolve-git-metadata.js";
import type { EvalReporter } from "#evals/runner/reporters/types.js";

/**
 * Configuration for the Braintrust reporter. Every field is optional and maps
 * onto the corresponding Braintrust SDK `init` option.
 */
export interface BraintrustReporterConfig {
  /** Braintrust project id. Maps to the `projectId` init option. */
  readonly projectId?: string;
  /** Braintrust project name. Defaults to the eval id when omitted. */
  readonly projectName?: string;
  /** Name for the created experiment. When omitted, Braintrust names it. */
  readonly experimentName?: string;
  /** Name of an existing experiment to compare results against (the diff base). */
  readonly baseExperimentName?: string;
  /** Id of an existing experiment to compare results against (the diff base). */
  readonly baseExperimentId?: string;
  /** When true, update a matching existing experiment instead of creating one. */
  readonly update?: boolean;
}

/**
 * Minimal typed surface of the Braintrust SDK consumed by this reporter.
 *
 * Declared locally so the `braintrust` package is never a compile-time
 * dependency. The reporter casts the dynamic import to this shape.
 */
interface BraintrustSdk {
  init(options: {
    project?: string;
    projectId?: string;
    experiment?: string;
    baseExperiment?: string;
    baseExperimentId?: string;
    update?: boolean;
    tags?: string[];
    metadata?: Record<string, unknown>;
    repoInfo?: {
      commit?: string;
      branch?: string;
    } | null;
    noExitFlush?: boolean;
    setCurrent?: boolean;
  }): Promise<BraintrustExperiment>;
  flush(): Promise<void>;
}

interface BraintrustExperiment {
  log(event: {
    id?: string;
    input?: unknown;
    output?: unknown;
    expected?: unknown;
    error?: unknown;
    scores?: Record<string, number>;
    metadata?: Record<string, unknown>;
    metrics?: Record<string, number>;
    tags?: string[];
  }): void;
  summarize(): Promise<BraintrustExperimentSummary>;
  close(): Promise<string>;
}

interface BraintrustExperimentSummary {
  experimentName?: string;
  experimentUrl?: string;
  projectName?: string;
  projectUrl?: string;
  scores?: Record<string, { name: string; score: number; diff?: number }>;
}

/**
 * Creates an {@link EvalReporter} that uploads eval results to Braintrust as an
 * experiment. Add it to an eval's `reporters` array; share one instance
 * across several evals (e.g. every entry of an array export) to group them
 * into a single experiment. Requires the optional `braintrust` peer package;
 * the reporter throws a descriptive error when the run starts if it is
 * missing. `config` is optional and defaults to an empty object (the project
 * name then falls back to the first observed eval id).
 */
export function Braintrust(config: BraintrustReporterConfig = {}): EvalReporter {
  return new BraintrustReporter(config);
}

/**
 * Reporter that uploads eval results to Braintrust as experiments.
 */
class BraintrustReporter implements EvalReporter {
  readonly #config: BraintrustReporterConfig;
  #sdk: BraintrustSdk | undefined;
  #experiment: BraintrustExperiment | undefined;
  readonly #evaluations = new Map<string, EveEval>();

  constructor(config: BraintrustReporterConfig) {
    this.#config = config;
  }

  async onRunStart(evaluations: readonly EveEval[], target: EveEvalTarget): Promise<void> {
    const sdk = await loadBraintrustSdk();
    this.#sdk = sdk;
    const git = resolveLocalGitMetadata(process.cwd());

    this.#evaluations.clear();
    for (const evaluation of evaluations) {
      this.#evaluations.set(evaluation.id, evaluation);
    }

    const tags = resolveTags(evaluations, target);
    const metadata = resolveExperimentMetadata(evaluations, target);

    this.#experiment = await sdk.init({
      project: this.#config.projectName ?? evaluations[0]?.id ?? "eve evals",
      projectId: this.#config.projectId,
      experiment: this.#config.experimentName,
      baseExperiment: this.#config.baseExperimentName,
      baseExperimentId: this.#config.baseExperimentId,
      update: this.#config.update,
      tags,
      metadata,
      noExitFlush: true,
      setCurrent: false,
      repoInfo: git.sha ? { commit: git.sha, branch: git.branch } : null,
    });
  }

  onEvalComplete(result: EveEvalResult): void {
    if (!this.#experiment) return;
    const evaluation = this.#evaluations.get(result.id);

    // Soft assertions log under their own name; gate assertions log as binary
    // scores under a `gate:` prefix so experiments diff gate regressions the
    // same way they diff soft-score regressions.
    const scores: Record<string, number> = {};
    for (const assertion of result.assertions) {
      const key = assertion.severity === "gate" ? `gate:${assertion.name}` : assertion.name;
      scores[key] = assertion.score;
    }

    const failedAssertions = result.assertions
      .filter((assertion) => !assertion.passed)
      .map((assertion) => ({ name: assertion.name, message: assertion.message }));

    const metadata: Record<string, unknown> = {
      ...evaluation?.metadata,
      eveSessionId: result.result.sessionId,
      eveStatus: result.result.status,
      eveVerdict: result.verdict,
      eveToolCalls: result.result.derived.toolCalls.map((call) => call.name),
      eveSubagentCalls: result.result.derived.subagentCalls.map((call) => call.name),
      eveParked: result.result.derived.parked,
    };

    if (failedAssertions.length > 0) {
      metadata.eveFailedAssertions = failedAssertions;
    }

    if (result.result.derived.failureCode) {
      metadata.eveFailureCode = result.result.derived.failureCode;
    }

    const metrics: Record<string, number> = {
      toolCallCount: result.result.derived.toolCallCount,
      subagentCallCount: result.result.derived.subagentCallCount,
      messageCount: result.result.derived.messageCount,
      reasoningBlockCount: result.result.derived.reasoningBlockCount,
    };

    this.#experiment.log({
      id: result.id,
      input: evaluation?.description ?? "",
      output: result.result.output,
      error: result.error ?? undefined,
      scores,
      metadata,
      metrics,
      tags: evaluation?.tags ? [...evaluation.tags] : undefined,
    });
  }

  async onRunComplete(_summary: EveEvalRunSummary): Promise<void> {
    if (!this.#experiment) return;

    try {
      // Flush pending writes before summarizing
      if (this.#sdk) {
        await this.#sdk.flush();
      }

      const summary = await this.#experiment.summarize();

      if (summary.experimentUrl) {
        console.log(`Braintrust experiment: ${summary.experimentUrl}\n\n`);
      }
    } finally {
      await this.#experiment.close();
      this.#experiment = undefined;
      this.#sdk = undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Peer dependency specifier kept in a variable so the dynamic import is
 * not statically analyzable and TypeScript does not require type
 * declarations for the package at compile time.
 */
const BRAINTRUST_PACKAGE = "braintrust";

async function loadBraintrustSdk(): Promise<BraintrustSdk> {
  try {
    return (await import(BRAINTRUST_PACKAGE)) as unknown as BraintrustSdk;
  } catch {
    throw new Error(
      [
        "The 'braintrust' package is required for Braintrust reporting but was not found.",
        "",
        "Install it with:",
        "  npm install braintrust",
      ].join("\n"),
    );
  }
}

function resolveTags(evaluations: readonly EveEval[], target: EveEvalTarget): string[] {
  const tags = new Set<string>(["eve", `target:${target.kind}`]);

  for (const evaluation of evaluations) {
    tags.add(`eval:${evaluation.id}`);
    for (const tag of evaluation.tags ?? []) {
      tags.add(tag);
    }
  }

  return [...tags];
}

function resolveExperimentMetadata(
  evaluations: readonly EveEval[],
  target: EveEvalTarget,
): Record<string, unknown> {
  return {
    eveEvalIds: evaluations.map((evaluation) => evaluation.id),
    eveTargetKind: target.kind,
    eveTargetUrl: target.url,
    eveTimestamp: new Date().toISOString(),
  };
}
