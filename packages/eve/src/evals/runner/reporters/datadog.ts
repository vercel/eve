import { createRequire } from "node:module";

import type { EveEval, EveEvalResult, EveEvalRunSummary, EveEvalTarget } from "#evals/types.js";
import type { EvalReporter } from "#evals/runner/reporters/types.js";
import { resolveLocalGitMetadata } from "#evals/runner/resolve-git-metadata.js";

/** Configuration for the Datadog reporter. */
export interface DatadogReporterConfig {
  /** Datadog LLM Observability project name. Defaults to `DD_LLMOBS_ML_APP`, `DD_SERVICE`, or the first eval id. */
  readonly projectName?: string;
  /** Name for the placeholder dataset used by the experiment. Defaults to `<experimentName> dataset`. */
  readonly datasetName?: string;
  /** Name for the created experiment. Defaults to a timestamped eve eval run name. */
  readonly experimentName?: string;
  /** Optional experiment description. */
  readonly description?: string;
  /** Datadog service name used when the reporter initializes `dd-trace`. */
  readonly service?: string;
  /** Datadog env used when the reporter initializes `dd-trace`. */
  readonly env?: string;
  /** Datadog site used when the reporter initializes `dd-trace`. */
  readonly site?: string;
  /** LLM Observability ml_app used when the reporter initializes `dd-trace`. Defaults to `projectName`. */
  readonly mlApp?: string;
  /** Tags attached to the Datadog Experiment. */
  readonly tags?: Readonly<Record<string, string>>;
  /** Metadata attached to the Datadog Experiment. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Free-form Datadog Experiment config. */
  readonly config?: Readonly<Record<string, unknown>>;
  /** Include eval descriptions in the synthetic experiment row input. Defaults to false. */
  readonly recordInputs?: boolean;
  /** Include eval outputs in the synthetic experiment row output. Defaults to false. */
  readonly recordOutputs?: boolean;
  /** Include `metadata.expectedOutput`, `metadata.expected`, or `metadata.expected_output` on experiment rows. Defaults to false. */
  readonly recordExpectedOutputs?: boolean;
  /** Console hook used for tests. */
  readonly log?: (line: string) => void;
  /** eve-owned client seam for tests and custom Datadog SDK wiring. */
  readonly client?: {
    startExperiment(options: DatadogStartExperimentOptions): Promise<DatadogExternalExperiment>;
  };
}

interface DatadogStartExperimentOptions {
  name: string;
  projectName?: string;
  description?: string;
  tags?: Readonly<Record<string, string>>;
  metadata?: Readonly<Record<string, unknown>>;
  config?: Readonly<Record<string, unknown>>;
  dataset?: {
    name?: string;
  };
}

interface DatadogExternalExperiment {
  experimentId(): string | null;
  url(): string | null;
  submitSpan(row: DatadogExternalExperimentSpanInput): Promise<DatadogExternalExperimentSpan>;
  submitEvaluationMetrics(
    span: Pick<DatadogExternalExperimentSpan, "experimentId" | "spanId" | "traceId">,
    metrics: readonly DatadogEvaluationMetricInput[],
  ): Promise<void>;
  close(options?: { status?: "completed" | "failed"; error?: string }): Promise<void>;
}

interface DatadogExternalExperimentSpanInput {
  id?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  expectedOutput?: unknown;
  metadata?: Readonly<Record<string, unknown>>;
  tags?: Readonly<Record<string, string>>;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
}

interface DatadogExternalExperimentSpan {
  experimentId: string | null;
  spanId: string | null;
  traceId?: string | null;
  url?: string | null;
}

interface DatadogEvaluationMetricInput {
  label: string;
  value?: boolean | number | string | Record<string, unknown>;
  error?: string;
  tags?: Readonly<Record<string, string>>;
}

interface DatadogTraceModule {
  init(options: {
    service?: string;
    env?: string;
    site?: string;
    llmobs?: {
      mlApp?: string;
      agentlessEnabled?: boolean;
    };
  }): DatadogTracer;
}

interface DatadogTracer {
  readonly llmobs?: {
    readonly experiments?: {
      startExperiment(options: DatadogStartExperimentOptions): Promise<DatadogExternalExperiment>;
    };
  };
}

/**
 * Creates an {@link EvalReporter} that uploads eval assertion scores to a
 * Datadog LLM Observability Experiment. Requires the optional `dd-trace`
 * package and `DD_API_KEY`/`DD_APP_KEY` credentials unless `config.client` is
 * provided.
 */
export function Datadog(config: DatadogReporterConfig = {}): EvalReporter {
  return new DatadogReporter(config);
}

class DatadogReporter implements EvalReporter {
  readonly #config: DatadogReporterConfig;
  readonly #evaluations = new Map<string, EveEval>();
  #experiment: DatadogExternalExperiment | undefined;

  constructor(config: DatadogReporterConfig) {
    this.#config = config;
  }

  async onRunStart(evaluations: readonly EveEval[], target: EveEvalTarget): Promise<void> {
    this.#evaluations.clear();
    for (const evaluation of evaluations) {
      this.#evaluations.set(evaluation.id, evaluation);
    }

    const client = await resolveDatadogClient(this.#config, evaluations);
    const git = resolveLocalGitMetadata(process.cwd());

    const experimentName = this.#config.experimentName ?? defaultExperimentName();
    this.#experiment = await client.startExperiment({
      name: experimentName,
      projectName: resolveProjectName(this.#config, evaluations),
      description: this.#config.description,
      dataset: { name: this.#config.datasetName ?? `${experimentName} dataset` },
      tags: resolveExperimentTags(this.#config, target),
      metadata: {
        ...resolveExperimentMetadata(evaluations, target),
        ...(git.sha ? { eveGitCommit: git.sha, eveGitBranch: git.branch } : {}),
        ...this.#config.metadata,
      },
      config: this.#config.config,
    });
  }

  async onEvalComplete(result: EveEvalResult): Promise<void> {
    if (!this.#experiment) return;

    const evaluation = this.#evaluations.get(result.id);
    const span = await this.#experiment.submitSpan({
      id: result.id,
      name: result.id,
      input: this.#config.recordInputs ? resolveInput(result, evaluation) : undefined,
      output: this.#config.recordOutputs ? result.result.output : undefined,
      expectedOutput: this.#config.recordExpectedOutputs
        ? resolveExpectedOutput(evaluation)
        : undefined,
      metadata: resolveResultMetadata(result, evaluation),
      tags: resolveResultTags(result, evaluation),
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      durationMs: elapsedMs(result.startedAt, result.completedAt),
      error: result.error,
    });

    await this.#experiment.submitEvaluationMetrics(span, resolveEvaluationMetrics(result));
  }

  async onRunComplete(summary: EveEvalRunSummary): Promise<void> {
    if (!this.#experiment) return;

    try {
      const failed = summary.failed > 0 || summary.errored > 0;
      await this.#experiment.close({
        status: failed ? "failed" : "completed",
        error: failed ? `${summary.failed} failed, ${summary.errored} errored` : undefined,
      });

      const url = this.#experiment.url();
      if (url) {
        (this.#config.log ?? console.log)(`Datadog experiment URL: ${url}\n`);
      }
    } finally {
      this.#experiment = undefined;
    }
  }
}

const DD_TRACE_PACKAGE = "dd-trace";

async function resolveDatadogClient(
  config: DatadogReporterConfig,
  evaluations: readonly EveEval[],
): Promise<{
  startExperiment(options: DatadogStartExperimentOptions): Promise<DatadogExternalExperiment>;
}> {
  if (config.client) return config.client;

  const sdk = await loadDatadogSdk();
  const projectName = resolveProjectName(config, evaluations);
  const tracer = sdk.init({
    service: config.service ?? process.env.DD_SERVICE ?? projectName,
    env: config.env ?? process.env.DD_ENV,
    site: config.site ?? process.env.DD_SITE,
    llmobs: {
      mlApp: config.mlApp ?? projectName,
      agentlessEnabled: true,
    },
  });

  const experiments = tracer.llmobs?.experiments;
  if (!experiments?.startExperiment) {
    throw new Error(
      "The installed 'dd-trace' package does not expose tracer.llmobs.experiments.startExperiment().",
    );
  }
  return experiments;
}

async function loadDatadogSdk(): Promise<DatadogTraceModule> {
  try {
    const requireFromApp = createRequire(`${process.cwd()}/package.json`);
    return requireFromApp(DD_TRACE_PACKAGE) as DatadogTraceModule;
  } catch {
    try {
      const mod = (await import(DD_TRACE_PACKAGE)) as { default?: unknown };
      return (mod.default ?? mod) as DatadogTraceModule;
    } catch {
      throw new Error(
        [
          "The 'dd-trace' package is required for Datadog reporting but was not found.",
          "",
          "Install it with:",
          "  npm install dd-trace",
        ].join("\n"),
      );
    }
  }
}

function resolveProjectName(
  config: DatadogReporterConfig,
  evaluations: readonly EveEval[],
): string {
  return (
    config.projectName ??
    config.mlApp ??
    process.env.DD_LLMOBS_ML_APP ??
    process.env.DD_SERVICE ??
    evaluations[0]?.id ??
    "eve evals"
  );
}

function defaultExperimentName(): string {
  return `eve evals ${new Date().toISOString()}`;
}

function resolveExperimentTags(
  config: DatadogReporterConfig,
  target: EveEvalTarget,
): Record<string, string> {
  return {
    source: "eve",
    target_kind: target.kind,
    ...config.tags,
  };
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

function resolveResultTags(
  result: EveEvalResult,
  evaluation: EveEval | undefined,
): Record<string, string> {
  return {
    eval_id: result.id,
    eval_verdict: result.verdict,
    eval_status: result.result.status,
    ...(evaluation?.tags?.length ? { eval_tags: evaluation.tags.join(",") } : {}),
  };
}

function resolveInput(result: EveEvalResult, evaluation: EveEval | undefined): unknown {
  for (const event of result.result.events) {
    if (event.type !== "message.received") continue;
    return event.data.message;
  }

  return evaluation?.description ?? "";
}

function resolveExpectedOutput(evaluation: EveEval | undefined): unknown {
  if (!evaluation?.metadata) return undefined;
  return (
    evaluation.metadata.expectedOutput ??
    evaluation.metadata.expected ??
    evaluation.metadata.expected_output
  );
}

function resolveResultMetadata(
  result: EveEvalResult,
  evaluation: EveEval | undefined,
): Record<string, unknown> {
  const failedAssertions = result.assertions
    .filter((assertion) => !assertion.passed)
    .map((assertion) => ({ name: assertion.name, message: assertion.message }));

  return {
    ...evaluation?.metadata,
    eveSessionId: result.result.sessionId,
    eveStatus: result.result.status,
    eveVerdict: result.verdict,
    eveSkipReason: result.skipReason,
    eveToolCalls: result.result.derived.toolCalls.map((call) => call.name),
    eveSubagentCalls: result.result.derived.subagentCalls.map((call) => call.name),
    eveParked: result.result.derived.parked,
    ...(failedAssertions.length > 0 ? { eveFailedAssertions: failedAssertions } : {}),
    ...(result.result.derived.failureCode
      ? { eveFailureCode: result.result.derived.failureCode }
      : {}),
  };
}

function resolveEvaluationMetrics(result: EveEvalResult): DatadogEvaluationMetricInput[] {
  const metrics: DatadogEvaluationMetricInput[] = [];

  for (const assertion of result.assertions) {
    const rawLabel = assertion.severity === "gate" ? `gate_${assertion.name}` : assertion.name;
    metrics.push({
      label: toDatadogMetricLabel(rawLabel),
      value: assertion.score,
      tags: {
        assertion_name: assertion.name,
        assertion_label: rawLabel,
        assertion_severity: assertion.severity,
        assertion_passed: String(assertion.passed),
      },
    });
  }

  metrics.push(
    { label: "eve_tool_call_count", value: result.result.derived.toolCallCount },
    { label: "eve_subagent_call_count", value: result.result.derived.subagentCallCount },
    { label: "eve_message_count", value: result.result.derived.messageCount },
    { label: "eve_reasoning_block_count", value: result.result.derived.reasoningBlockCount },
  );

  return metrics;
}

function toDatadogMetricLabel(label: string): string {
  const normalized = label.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "metric";
}

function elapsedMs(startedAt: string, completedAt: string): number | undefined {
  const start = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(completed)) return undefined;
  return Math.max(0, completed - start);
}
