import { outputOf } from "#evals/output.js";
import type {
  EveEval,
  EveEvalResult,
  EveEvalRunSummary,
  EveEvalTarget,
  EveEvalTaskResult,
} from "#evals/types.js";
import {
  composeAssertionScoreMetadata,
  exportedAssertionName,
  groupAssertionScores,
} from "#evals/runner/reporters/assertion-scores.js";
import { resolveLocalGitMetadata } from "#evals/runner/resolve-git-metadata.js";
import { formatAttemptLabel } from "#evals/runner/attempt-label.js";
import type { EvalReporter } from "#evals/runner/reporters/types.js";
import type { TokenUsage } from "#shared/token-usage.js";

/**
 * Configuration for the Braintrust reporter. Every field is optional; most map
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
  /**
   * Experiment metadata merged over the metadata eve sets (`eveEvalIds`,
   * `eveTargetKind`, `eveTargetUrl`, `eveTimestamp`). A key you set replaces
   * eve's value for that key.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Experiment tags appended after the tags eve sets. Duplicates are dropped. */
  readonly tags?: readonly string[];
  /**
   * Git metadata for the experiment. When omitted, eve reads the commit and
   * branch from the repository at `cwd`. Pass an object to report it as is, or
   * `null` to report no git metadata.
   */
  readonly repoInfo?: BraintrustRepoInfo | null;
  /**
   * Directory eve reads git metadata from when `repoInfo` is omitted.
   * Defaults to `process.cwd()`.
   */
  readonly cwd?: string;
}

/** Git metadata reported on a Braintrust experiment. Every field is optional. */
export interface BraintrustRepoInfo {
  /** Commit SHA. */
  readonly commit?: string | null;
  /** Branch name. */
  readonly branch?: string | null;
  /** Tag pointing at the commit. */
  readonly tag?: string | null;
  /** Whether the working tree had uncommitted changes. */
  readonly dirty?: boolean | null;
  /** Commit author name. */
  readonly author_name?: string | null;
  /** Commit author email. */
  readonly author_email?: string | null;
  /** Commit message. */
  readonly commit_message?: string | null;
  /** Commit timestamp. */
  readonly commit_time?: string | null;
  /** Diff of uncommitted changes. */
  readonly git_diff?: string | null;
}

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
    repoInfo?: BraintrustRepoInfo | null;
    gitMetadataSettings?: { collect: "none" };
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
export function braintrustReporter(config: BraintrustReporterConfig = {}): EvalReporter {
  return new BraintrustReporter(config);
}

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

    this.#evaluations.clear();
    for (const evaluation of evaluations) {
      this.#evaluations.set(evaluation.id, evaluation);
    }

    const tags = resolveTags(evaluations, target, this.#config.tags ?? []);
    const metadata = {
      ...resolveExperimentMetadata(evaluations, target),
      ...this.#config.metadata,
    };

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
      ...resolveRepoInfo(this.#config),
    });
  }

  onEvalComplete(result: EveEvalResult): void {
    if (!this.#experiment) return;
    const evaluation = this.#evaluations.get(result.id);

    const scores: Record<string, number> = {};
    const groups = groupAssertionScores(result.assertions, exportedAssertionName);
    for (const [name, group] of groups) {
      if (group.score !== undefined) scores[name] = group.score;
    }

    const failedAssertions = result.assertions
      .filter((assertion) => assertion.passed === false)
      .map((assertion) => ({ ...assertion }));

    const metadata: Record<string, unknown> = {
      ...evaluation?.metadata,
      eveAttempt: result.attempt,
      eveSessionId: result.result.sessionId,
      eveStatus: result.result.status,
      eveVerdict: result.verdict,
      eveSkipReason: result.skipReason,
      eveToolCalls: result.result.derived.toolCalls.map((call) => call.name),
      eveSubagentCalls: result.result.derived.subagentCalls.map((call) => call.name),
      eveSkillLoads: result.result.derived.skillLoads.map((load) => load.skill),
      eveAwaitingInput: result.result.status === "awaiting-input",
      eveSessionEnded: result.result.sessionEnded,
      eveAssertionScores: composeAssertionScoreMetadata(result.assertions),
    };

    if (result.result.traceContexts.length > 0) {
      metadata.eveTraceIds = [
        ...new Set(result.result.traceContexts.map((traceContext) => traceContext.traceId)),
      ];
      metadata.eveTraceContexts = result.result.traceContexts;
    }

    if (failedAssertions.length > 0) {
      metadata.eveFailedAssertions = failedAssertions;
    }

    if (result.result.derived.failureCode) {
      metadata.eveFailureCode = result.result.derived.failureCode;
    }

    if (result.result.derived.models.length > 0) {
      metadata.eveModels = result.result.derived.models;
    }

    const sessions = sessionMetadata(result.result);
    if (sessions.length > 0) {
      metadata.eveSessions = sessions;
    }

    const metrics: Record<string, number> = {
      toolCallCount: result.result.derived.toolCallCount,
      subagentCallCount: result.result.derived.subagentCallCount,
      messageCount: result.result.derived.messageCount,
      reasoningBlockCount: result.result.derived.reasoningBlockCount,
      ...usageMetrics(result.result.derived.usage),
    };

    this.#experiment.log({
      id: formatAttemptLabel(result.id, result.attempt),
      input: evaluation?.description ?? "",
      output: outputOf(result.result) ?? "",
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

function usageMetrics(usage: TokenUsage | undefined): Record<string, number> {
  if (usage === undefined) return {};
  const metrics: Record<string, number> = {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    tokens: usage.inputTokens + usage.outputTokens,
    prompt_cached_tokens: usage.cacheReadTokens,
    prompt_cache_creation_tokens: usage.cacheWriteTokens,
  };
  if (usage.costUsd !== undefined) metrics.estimated_cost = usage.costUsd;
  return metrics;
}

function sessionMetadata(result: EveEvalTaskResult): Record<string, unknown>[] {
  return (result.sessions ?? []).map((session) => {
    const entry: Record<string, unknown> = {
      sessionId: session.sessionId,
      primary: session.primary,
      models: session.derived.models,
    };
    if (session.derived.usage !== undefined) entry.usage = session.derived.usage;
    return entry;
  });
}

function resolveTags(
  evaluations: readonly EveEval[],
  target: EveEvalTarget,
  extra: readonly string[],
): string[] {
  const tags = new Set<string>(["eve", `target:${target.kind}`]);

  for (const evaluation of evaluations) {
    tags.add(`eval:${evaluation.id}`);
    for (const tag of evaluation.tags ?? []) {
      tags.add(tag);
    }
  }

  for (const tag of extra) {
    tags.add(tag);
  }

  return [...tags];
}

function resolveRepoInfo(config: BraintrustReporterConfig): {
  repoInfo: BraintrustRepoInfo | null;
  gitMetadataSettings?: { collect: "none" };
} {
  if (config.repoInfo === null) return { repoInfo: null, gitMetadataSettings: { collect: "none" } };
  if (config.repoInfo !== undefined) return { repoInfo: config.repoInfo };
  const git = resolveLocalGitMetadata(config.cwd ?? process.cwd());
  return { repoInfo: git.sha ? { commit: git.sha, branch: git.branch } : null };
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
