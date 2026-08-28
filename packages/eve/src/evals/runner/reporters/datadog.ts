import type { EveEval, EveEvalResult, EveEvalRunSummary, EveEvalTarget } from "#evals/types.js";
import { resolveLocalGitMetadata } from "#evals/runner/resolve-git-metadata.js";
import type { EvalReporter, EveEvalRunStartContext } from "#evals/runner/reporters/types.js";
import { buildEvalTraceMetadata } from "#evals/runner/reporters/trace-metadata.js";
import { parseJsonValue, type JsonObject, type JsonValue } from "#shared/json.js";

/** Dataset associated with a Datadog external experiment. */
export interface DatadogReporterDataset {
  /** Existing Datadog dataset id. Omit to let Datadog create a placeholder dataset. */
  readonly id?: string;
  /** Existing dataset version. */
  readonly version?: number;
  /** Name for a Datadog-created placeholder dataset. */
  readonly name?: string;
  /** Description for a Datadog-created placeholder dataset. */
  readonly description?: string;
}

/** Configuration for the Datadog eval reporter. */
export interface DatadogReporterConfig {
  /** Datadog LLM Observability project. Defaults to the first observed eval id. */
  readonly projectName?: string;
  /** External experiment name. Defaults to a timestamped eve eval name. */
  readonly experimentName?: string;
  /** Description attached to the external experiment. */
  readonly description?: string;
  /** Existing dataset, or settings for the placeholder dataset Datadog creates. */
  readonly dataset?: DatadogReporterDataset;
  /** Configuration values recorded on the external experiment. */
  readonly experimentConfig?: Readonly<Record<string, JsonValue>>;
  /** Additional metadata recorded on the external experiment. */
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  /** Additional tags recorded on the experiment and every submitted eval. */
  readonly tags?: Readonly<Record<string, string>>;
}

interface DatadogTracer {
  init(options: {
    llmobs: {
      agentlessEnabled: boolean;
      mlApp: string;
    };
  }): DatadogTracer;
  readonly llmobs: {
    readonly experiments: {
      startExperiment(options: DatadogStartExperimentOptions): Promise<DatadogExperiment>;
    };
  };
}

interface DatadogStartExperimentOptions {
  readonly name: string;
  readonly description?: string;
  readonly projectName?: string;
  readonly dataset?: DatadogReporterDataset;
  readonly config?: Readonly<Record<string, JsonValue>>;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly tags?: Readonly<Record<string, string>>;
}

interface DatadogExperimentSpan {
  readonly experimentId: string;
  readonly spanId: string;
  readonly traceId: string;
  readonly url: string | null;
}

interface DatadogExperimentMetric {
  readonly label: string;
  readonly value: JsonValue;
  readonly source: string;
  readonly tags?: Readonly<Record<string, string>>;
}

interface DatadogExperiment {
  url(): string | null;
  submitSpan(input: {
    readonly name?: string;
    readonly input?: JsonValue;
    readonly output?: JsonValue;
    readonly metadata?: Readonly<Record<string, JsonValue>>;
    readonly tags?: Readonly<Record<string, string>>;
    readonly startedAt?: string;
    readonly completedAt?: string;
    readonly error?: string;
  }): Promise<DatadogExperimentSpan>;
  submitEvaluationMetrics(
    span: DatadogExperimentSpan,
    metrics: readonly DatadogExperimentMetric[],
  ): Promise<void>;
  close(options?: { readonly status?: string; readonly error?: string }): Promise<void>;
}

/**
 * Creates an {@link EvalReporter} that uploads one external Datadog experiment
 * per eval run. Requires `dd-trace` 6.12 or newer plus `DD_API_KEY` and
 * `DD_APP_KEY`. Runtime tracing is optional; when present, eve records the
 * observed runtime trace contexts as eval metadata and stable correlation tags.
 */
export function Datadog(config: DatadogReporterConfig = {}): EvalReporter {
  return new DatadogReporter(config);
}

class DatadogReporter implements EvalReporter {
  readonly #config: DatadogReporterConfig;
  readonly #evaluations = new Map<string, EveEval>();
  #experiment: DatadogExperiment | undefined;

  constructor(config: DatadogReporterConfig) {
    this.#config = config;
  }

  async onRunStart(
    evaluations: readonly EveEval[],
    target: EveEvalTarget,
    context?: EveEvalRunStartContext,
  ): Promise<void> {
    requireDatadogCredentials();
    const tracer = await loadDatadogTracer();
    const projectName = this.#config.projectName ?? evaluations[0]?.id ?? "eve evals";
    tracer.init({
      llmobs: {
        agentlessEnabled: true,
        mlApp: projectName,
      },
    });

    this.#evaluations.clear();
    for (const evaluation of evaluations) {
      this.#evaluations.set(evaluation.id, evaluation);
    }

    const git = resolveLocalGitMetadata(process.cwd());
    const startedAt = context?.startedAt ?? new Date().toISOString();
    this.#experiment = await tracer.llmobs.experiments.startExperiment({
      name: this.#config.experimentName ?? `eve eval ${startedAt}`,
      description: this.#config.description,
      projectName,
      dataset: this.#config.dataset,
      config: this.#config.experimentConfig,
      metadata: compactJsonObject({
        ...this.#config.metadata,
        "eve.eval.names": evaluations.map((evaluation) => evaluation.id),
        "eve.eval.run_id": context?.runId,
        "eve.git.branch": git.branch,
        "eve.git.sha": git.sha,
        "eve.target.kind": target.kind,
        "eve.target.url": target.url,
      }),
      tags: compactStringRecord({
        ...this.#config.tags,
        "eve.eval.run_id": context?.runId,
        "eve.framework": "eve",
        "eve.target.kind": target.kind,
      }),
    });
  }

  async onEvalComplete(result: EveEvalResult): Promise<void> {
    if (!this.#experiment) return;
    const evaluation = this.#evaluations.get(result.id);
    const failedAssertions = result.assertions
      .filter((assertion) => !assertion.passed)
      .map((assertion) => ({ ...assertion }));

    const metadata = compactJsonObject({
      ...normalizeMetadata(evaluation?.metadata),
      "eve.assertions.failed": failedAssertions,
      "eve.eval.id": result.caseId,
      "eve.eval.name": result.id,
      "eve.eval.run_id": result.runId,
      "eve.eval.tags": evaluation?.tags,
      "eve.failure.code": result.result.derived.failureCode,
      "eve.parked": result.result.derived.parked,
      "eve.session.id": result.result.sessionId,
      "eve.skip.reason": result.skipReason,
      "eve.status": result.result.status,
      "eve.subagent.calls": result.result.derived.subagentCalls.map((call) => call.name),
      "eve.tool.calls": result.result.derived.toolCalls.map((call) => call.name),
      "eve.verdict": result.verdict,
      ...buildEvalTraceMetadata(result.result.traceContexts),
    });
    const output = normalizeJsonValue(result.result.output);
    const span = await this.#experiment.submitSpan({
      name: result.id,
      input: evaluation?.description ?? result.id,
      output,
      metadata,
      tags: compactStringRecord({
        ...this.#config.tags,
        "eve.eval.id": result.caseId,
        "eve.eval.name": result.id,
        "eve.eval.run_id": result.runId,
        "eve.session.id": result.result.sessionId,
        "eve.verdict": result.verdict,
      }),
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      error: result.error,
    });

    await this.#experiment.submitEvaluationMetrics(span, buildMetrics(result));
  }

  async onRunComplete(_summary: EveEvalRunSummary): Promise<void> {
    if (!this.#experiment) return;

    const experiment = this.#experiment;
    this.#experiment = undefined;
    try {
      await experiment.close({ status: "completed" });
      const url = experiment.url();
      if (url) console.log(`Datadog experiment: ${url}\n\n`);
    } finally {
      this.#evaluations.clear();
    }
  }
}

const DATADOG_PACKAGE = "dd-trace";

async function loadDatadogTracer(): Promise<DatadogTracer> {
  try {
    const module = (await import(DATADOG_PACKAGE)) as {
      readonly default?: DatadogTracer;
    } & DatadogTracer;
    return module.default ?? module;
  } catch {
    throw new Error(
      [
        "The 'dd-trace' package (version 6.12 or newer) is required for Datadog reporting but was not found.",
        "",
        "Install it with:",
        "  npm install dd-trace",
      ].join("\n"),
    );
  }
}

function requireDatadogCredentials(): void {
  const missing = ["DD_API_KEY", "DD_APP_KEY"].filter((name) => !process.env[name]);
  if (missing.length === 0) return;
  throw new Error(`Datadog reporting requires ${missing.join(" and ")} in the environment.`);
}

function buildMetrics(result: EveEvalResult): DatadogExperimentMetric[] {
  const metrics: DatadogExperimentMetric[] = [
    {
      label: "eve_verdict",
      source: "eve",
      value: result.verdict,
    },
  ];
  const labels = new Map<string, number>([["eve_verdict", 1]]);

  for (const assertion of result.assertions) {
    const assertionName = assertion.severity === "gate" ? `gate_${assertion.name}` : assertion.name;
    const baseLabel = normalizeMetricLabel(assertionName);
    const count = (labels.get(baseLabel) ?? 0) + 1;
    labels.set(baseLabel, count);
    metrics.push({
      label: count === 1 ? baseLabel : `${baseLabel}_${count}`,
      source: "eve",
      value: assertion.score,
      tags: compactStringRecord({
        "eve.assertion.name": assertion.name,
        "eve.assertion.passed": String(assertion.passed),
        "eve.assertion.severity": assertion.severity,
        "eve.assertion.threshold":
          assertion.threshold === undefined ? undefined : String(assertion.threshold),
      }),
    });
  }

  return metrics;
}

function normalizeMetricLabel(label: string): string {
  const normalized = label.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "eve_score";
}

function normalizeMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, JsonValue>> {
  if (metadata === undefined) return {};

  const normalized: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const json = normalizeJsonValue(value);
    if (json !== undefined) normalized[key] = json;
  }
  return normalized;
}

function normalizeJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    return parseJsonValue(value);
  } catch {
    return String(value);
  }
}

function compactJsonObject(input: Readonly<Record<string, unknown>>): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    const normalized = normalizeJsonValue(value);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

function compactStringRecord(
  input: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
