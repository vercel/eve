import { createRequire } from "node:module";

import type ddTrace from "dd-trace";

import type { EveEval, EveEvalResult, EveEvalRunSummary, EveEvalTarget } from "#evals/types.js";
import type { EvalReporter } from "#evals/runner/reporters/types.js";
import { resolveLocalGitMetadata } from "#evals/runner/resolve-git-metadata.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";

/** Configuration for the Datadog reporter. */
export interface DatadogReporterConfig {
  /** Datadog LLM Observability project name. Defaults to `DD_LLMOBS_PROJECT_NAME`, the configured ml_app, `DD_SERVICE`, or the first eval id. */
  readonly projectName?: string;
  /** Name for the dataset used by the experiment. Defaults to `<experimentName> dataset`. */
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
  /** JSON-serializable metadata attached to the Datadog Experiment. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** JSON-serializable Datadog Experiment config. */
  readonly config?: Readonly<Record<string, unknown>>;
  /** Include the first sent message, falling back to the eval description, in the experiment row and a linked dataset record. Defaults to false. */
  readonly recordInputs?: boolean;
  /** Include eval outputs in the synthetic experiment row output. Defaults to false. */
  readonly recordOutputs?: boolean;
  /** Include `metadata.expectedOutput`, `metadata.expected`, or `metadata.expected_output` on experiment rows. Defaults to false. */
  readonly recordExpectedOutputs?: boolean;
  /** Include raw assertion names as metric tags and failure messages in row metadata. Defaults to false. */
  readonly recordAssertionDetails?: boolean;
  /** Include execution error messages, which may contain application data. Defaults to false. */
  readonly recordErrors?: boolean;
  /** Console hook used for tests. */
  readonly log?: (line: string) => void;
  /** eve-owned client seam for tests and custom Datadog SDK wiring. */
  readonly client?: DatadogExperimentsClient;
}

type DatadogJsonValue =
  | string
  | number
  | boolean
  | null
  | DatadogJsonValue[]
  | { [key: string]: DatadogJsonValue };

interface DatadogDatasetRecordInput {
  inputData: DatadogJsonValue;
  expectedOutput?: DatadogJsonValue;
  metadata?: Record<string, DatadogJsonValue>;
  tags?: string[];
}

interface DatadogDatasetRecord {
  readonly id: string | null;
}

interface DatadogDataset {
  id(): string | null;
  name(): string;
  version(): number | null;
  records(): readonly DatadogDatasetRecord[];
  url(): string | null;
  push(): Promise<{ pushedCount: number; totalCount: number }>;
}

interface DatadogExperimentsClient {
  createDataset?(
    name: string,
    options?: {
      projectName?: string;
      description?: string;
      records?: DatadogDatasetRecordInput[];
    },
  ): DatadogDataset;
  startExperiment(options: DatadogStartExperimentOptions): Promise<DatadogExternalExperiment>;
}

interface DatadogStartExperimentOptions {
  name: string;
  projectName?: string;
  description?: string;
  tags?: Record<string, string>;
  metadata?: Record<string, DatadogJsonValue>;
  config?: Record<string, DatadogJsonValue>;
  dataset?: {
    id?: string;
    version?: number;
    name?: string;
    description?: string;
  };
}

interface DatadogExternalExperiment {
  experimentId(): string;
  url(): string | null;
  submitSpan(row: DatadogExternalExperimentSpanInput): Promise<DatadogExternalExperimentSpan>;
  submitEvaluationMetrics(
    span: Pick<DatadogExternalExperimentSpan, "experimentId" | "spanId" | "traceId">,
    metrics: DatadogEvaluationMetricInput[],
  ): Promise<void>;
  close(options?: { status?: string; error?: string | Error }): Promise<void>;
}

interface DatadogExternalExperimentSpanInput {
  name?: string;
  input?: DatadogJsonValue;
  output?: DatadogJsonValue;
  expectedOutput?: DatadogJsonValue;
  metadata?: Record<string, DatadogJsonValue>;
  tags?: Record<string, string>;
  startedAt?: Date | string | number;
  completedAt?: Date | string | number;
  durationMs?: number;
  error?: string | Error | { type?: string; name?: string; message?: string; stack?: string };
  datasetRecordId?: string;
  runId?: string;
  runIteration?: number;
}

interface DatadogExternalExperimentSpan {
  experimentId: string;
  spanId: string;
  traceId: string;
  url: string | null;
}

interface DatadogEvaluationMetricInput {
  label: string;
  value?: DatadogJsonValue;
  error?: string | Error;
  timestamp?: Date | string | number;
  tags?: Record<string, string>;
  source?: string;
}

type DatadogTraceModule = typeof ddTrace;

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
  #client: DatadogExperimentsClient | undefined;
  #experimentOptions: DatadogStartExperimentOptions | undefined;
  #experiment: DatadogExternalExperiment | undefined;
  #datasetUrl: string | undefined;

  constructor(config: DatadogReporterConfig) {
    this.#config = config;
  }

  async onRunStart(evaluations: readonly EveEval[], target: EveEvalTarget): Promise<void> {
    this.#client = undefined;
    this.#experimentOptions = undefined;
    this.#experiment = undefined;
    this.#datasetUrl = undefined;
    this.#evaluations.clear();
    for (const evaluation of evaluations) {
      this.#evaluations.set(evaluation.id, evaluation);
    }

    const client = await resolveDatadogClient(this.#config, evaluations);
    const git = resolveLocalGitMetadata(process.cwd());

    const experimentName = this.#config.experimentName ?? defaultExperimentName();
    const metadata = resolveExperimentMetadata(evaluations, target);
    if (git.sha) {
      metadata.eveGitCommit = git.sha;
      metadata.eveGitBranch = git.branch;
    }
    Object.assign(metadata, this.#config.metadata);

    const experimentOptions: DatadogStartExperimentOptions = {
      name: experimentName,
      projectName: resolveProjectName(this.#config, evaluations),
      description: this.#config.description,
      dataset: { name: this.#config.datasetName ?? `${experimentName} dataset` },
      tags: resolveExperimentTags(this.#config, target),
      metadata: toDatadogJsonRecord(metadata),
      config: toDatadogJsonRecord(this.#config.config),
    };

    if (this.#config.recordInputs) {
      if (!client.createDataset) {
        throw new Error(
          "The installed 'dd-trace' package does not expose tracer.llmobs.experiments.createDataset().",
        );
      }
      this.#client = client;
      this.#experimentOptions = experimentOptions;
      return;
    }

    this.#experiment = await client.startExperiment(experimentOptions);
  }

  async onEvalComplete(result: EveEvalResult): Promise<void> {
    if (this.#config.recordInputs || !this.#experiment) return;
    await this.#submitResult(result);
  }

  async onRunComplete(summary: EveEvalRunSummary): Promise<void> {
    try {
      if (this.#config.recordInputs) {
        await this.#startDatasetBackedExperiment(summary.results);
      }
      if (!this.#experiment) return;

      const failed = summary.failed > 0 || summary.errored > 0;
      await this.#experiment.close({
        status: failed ? "failed" : "completed",
        error: failed ? `${summary.failed} failed, ${summary.errored} errored` : undefined,
      });

      const log = this.#config.log ?? console.log;
      if (this.#datasetUrl) {
        log(`Datadog dataset URL: ${this.#datasetUrl}\n`);
      }
      const experimentUrl = this.#experiment.url();
      if (experimentUrl) {
        log(`Datadog experiment URL: ${experimentUrl}\n`);
      }
    } finally {
      this.#client = undefined;
      this.#experimentOptions = undefined;
      this.#experiment = undefined;
      this.#datasetUrl = undefined;
    }
  }

  async #startDatasetBackedExperiment(results: readonly EveEvalResult[]): Promise<void> {
    const client = this.#client;
    const experimentOptions = this.#experimentOptions;
    if (!client?.createDataset || !experimentOptions) return;

    const datasetName = experimentOptions.dataset?.name ?? `${experimentOptions.name} dataset`;
    const records = results.map((result): DatadogDatasetRecordInput => {
      const evaluation = this.#evaluations.get(result.id);
      const record: DatadogDatasetRecordInput = {
        inputData: toDatadogJsonValue(resolveInput(result, evaluation)),
        metadata: { eveEvalId: result.id },
      };
      if (this.#config.recordExpectedOutputs) {
        const expectedOutput = toOptionalDatadogJsonValue(resolveExpectedOutput(evaluation));
        if (expectedOutput !== undefined) {
          record.expectedOutput = expectedOutput;
        }
      }
      return record;
    });
    const dataset = client.createDataset(datasetName, {
      projectName: experimentOptions.projectName,
      description:
        this.#config.description ?? `Eve eval inputs for experiment '${experimentOptions.name}'.`,
      records,
    });

    await dataset.push();
    const datasetId = dataset.id();
    if (!datasetId) {
      throw new Error(`Datadog dataset '${datasetName}' has no id after push().`);
    }
    const datasetRecords = dataset.records();
    if (datasetRecords.length !== results.length) {
      throw new Error(
        `Datadog dataset '${datasetName}' has ${datasetRecords.length} records for ${results.length} eval results.`,
      );
    }

    const datasetOptions: NonNullable<DatadogStartExperimentOptions["dataset"]> = {
      id: datasetId,
      name: dataset.name(),
    };
    const datasetVersion = dataset.version();
    if (datasetVersion !== null) {
      datasetOptions.version = datasetVersion;
    }
    this.#datasetUrl = dataset.url() ?? undefined;
    this.#experiment = await client.startExperiment({
      ...experimentOptions,
      dataset: datasetOptions,
    });

    for (const [index, result] of results.entries()) {
      const datasetRecordId = datasetRecords[index]?.id;
      if (!datasetRecordId) {
        throw new Error(`Datadog dataset record ${index + 1} has no id after push().`);
      }
      await this.#submitResult(result, datasetRecordId);
    }
  }

  async #submitResult(result: EveEvalResult, datasetRecordId?: string): Promise<void> {
    if (!this.#experiment) return;

    const evaluation = this.#evaluations.get(result.id);
    const spanInput: DatadogExternalExperimentSpanInput = {
      name: result.id,
      metadata: toDatadogJsonRecord(
        resolveResultMetadata(result, evaluation, this.#config.recordAssertionDetails === true),
      ),
      tags: resolveResultTags(result, evaluation),
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      durationMs: elapsedMs(result.startedAt, result.completedAt),
    };
    if (this.#config.recordInputs) {
      spanInput.input = toOptionalDatadogJsonValue(resolveInput(result, evaluation));
    }
    if (this.#config.recordOutputs) {
      spanInput.output = toOptionalDatadogJsonValue(result.result.output);
    }
    if (this.#config.recordExpectedOutputs) {
      spanInput.expectedOutput = toOptionalDatadogJsonValue(resolveExpectedOutput(evaluation));
    }
    if (this.#config.recordErrors && result.error !== undefined) {
      spanInput.error = result.error;
    }
    if (datasetRecordId !== undefined) {
      spanInput.datasetRecordId = datasetRecordId;
    }

    const span = await this.#experiment.submitSpan(spanInput);
    await this.#experiment.submitEvaluationMetrics(
      span,
      resolveEvaluationMetrics(result, this.#config.recordAssertionDetails === true),
    );
  }
}

const DD_TRACE_PACKAGE = "dd-trace";
const EXPECTED_OUTPUT_METADATA_KEYS: ReadonlySet<string> = new Set([
  "expectedOutput",
  "expected",
  "expected_output",
]);
const BUILT_IN_METRIC_LABELS = [
  "eve_tool_call_count",
  "eve_subagent_call_count",
  "eve_message_count",
  "eve_reasoning_block_count",
] as const;

async function resolveDatadogClient(
  config: DatadogReporterConfig,
  evaluations: readonly EveEval[],
): Promise<DatadogExperimentsClient> {
  if (config.client) return config.client;

  const sdk = await loadDatadogSdk();
  const projectName = resolveProjectName(config, evaluations);
  const tracer = sdk.init({
    service: config.service ?? process.env.DD_SERVICE ?? projectName,
    env: config.env ?? process.env.DD_ENV,
    site: config.site ?? process.env.DD_SITE,
    llmobs: {
      projectName,
      mlApp: config.mlApp ?? projectName,
      agentlessEnabled: true,
    },
  });

  const experiments = tracer.llmobs?.experiments;
  if (!experiments?.startExperiment) {
    throw new Error(
      [
        "The installed 'dd-trace' package does not expose tracer.llmobs.experiments.startExperiment().",
        "Update to a release compatible with dd-trace@6.13.0.",
      ].join("\n"),
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
          "Install the tested release with:",
          "  npm install dd-trace@6.13.0",
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
    process.env.DD_LLMOBS_PROJECT_NAME ??
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
  const metadata: Record<string, unknown> = {
    eveEvalIds: evaluations.map((evaluation) => evaluation.id),
    eveTargetKind: target.kind,
    eveTimestamp: new Date().toISOString(),
  };
  const targetOrigin = resolveTargetOrigin(target.url);
  if (targetOrigin !== undefined) {
    metadata.eveTargetOrigin = targetOrigin;
  }
  return metadata;
}

function resolveTargetOrigin(value: string): string | undefined {
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

function resolveResultTags(
  result: EveEvalResult,
  evaluation: EveEval | undefined,
): Record<string, string> {
  const tags: Record<string, string> = {
    eval_id: result.id,
    eval_verdict: result.verdict,
    eval_status: result.result.status,
  };
  if (evaluation?.tags?.length) {
    tags.eval_tags = evaluation.tags.join(",");
  }
  return tags;
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
  recordAssertionDetails: boolean,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(evaluation?.metadata ?? {})) {
    if (!EXPECTED_OUTPUT_METADATA_KEYS.has(key)) {
      metadata[key] = value;
    }
  }
  Object.assign(metadata, {
    eveSessionId: result.result.sessionId,
    eveStatus: result.result.status,
    eveVerdict: result.verdict,
    eveSkipReason: result.skipReason,
    eveToolCalls: result.result.derived.toolCalls.map((call) => call.name),
    eveSubagentCalls: result.result.derived.subagentCalls.map((call) => call.name),
    eveParked: result.result.derived.parked,
  });
  if (recordAssertionDetails) {
    const failedAssertions = result.assertions
      .filter((assertion) => !assertion.passed)
      .map((assertion) => ({ name: assertion.name, message: assertion.message }));
    if (failedAssertions.length > 0) {
      metadata.eveFailedAssertions = failedAssertions;
    }
  }
  if (result.result.derived.failureCode) {
    metadata.eveFailureCode = result.result.derived.failureCode;
  }
  return metadata;
}

function resolveEvaluationMetrics(
  result: EveEvalResult,
  recordAssertionDetails: boolean,
): DatadogEvaluationMetricInput[] {
  const metrics: DatadogEvaluationMetricInput[] = [];
  const usedLabels = new Set<string>(BUILT_IN_METRIC_LABELS);

  for (const [index, assertion] of result.assertions.entries()) {
    const rawLabel = assertion.severity === "gate" ? `gate_${assertion.name}` : assertion.name;
    const tags: Record<string, string> = {
      assertion_index: String(index + 1),
      assertion_severity: assertion.severity,
      assertion_passed: String(assertion.passed),
    };
    if (recordAssertionDetails) {
      tags.assertion_name = assertion.name;
      tags.assertion_label = rawLabel;
    }
    metrics.push({
      label: reserveDatadogMetricLabel(toDatadogMetricLabel(rawLabel), usedLabels),
      value: assertion.score,
      tags,
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

function reserveDatadogMetricLabel(baseLabel: string, usedLabels: Set<string>): string {
  let label = baseLabel;
  let suffix = 2;
  while (usedLabels.has(label)) {
    label = `${baseLabel}_${suffix}`;
    suffix += 1;
  }
  usedLabels.add(label);
  return label;
}

function elapsedMs(startedAt: string, completedAt: string): number | undefined {
  const start = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(completed)) return undefined;
  return Math.max(0, completed - start);
}

function toOptionalDatadogJsonValue(value: unknown): DatadogJsonValue | undefined {
  return value === undefined ? undefined : toDatadogJsonValue(value);
}

function toDatadogJsonRecord(
  value: Readonly<Record<string, unknown>> | undefined,
): Record<string, DatadogJsonValue> | undefined {
  if (value === undefined) return undefined;

  const output: Record<string, DatadogJsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      output[key] = toDatadogJsonValue(entry);
    }
  }
  return output;
}

function toDatadogJsonValue(value: unknown): DatadogJsonValue {
  return cloneDatadogJsonValue(parseJsonValue(value));
}

function cloneDatadogJsonValue(value: JsonValue): DatadogJsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneDatadogJsonValue(entry));
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, DatadogJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = cloneDatadogJsonValue(entry);
    }
    return output;
  }
  return value;
}
