import type { EveEval, EveEvalResult, EveEvalRunSummary, EveEvalTarget } from "#evals/types.js";
import { resolveRuntimeTraceLinks } from "#evals/runner/reporters/datadog-runtime-trace-links.js";
import type { EvalReporter } from "#evals/runner/reporters/types.js";
import {
  composeAssertionScoreMetadata,
  groupAssertionScores,
} from "#evals/runner/reporters/assertion-scores.js";
import {
  getDatadogDataset,
  MISSING_DATASET_API_MESSAGE,
  resolveDatadogClient,
  toDatadogJsonRecord,
  toDatadogJsonValue,
  toOptionalDatadogJsonValue,
  type DatadogDatasetRecord,
  type DatadogDatasetRecordFields,
  type DatadogDatasetRecordInput,
  type DatadogEvaluationMetricInput,
  type DatadogExperimentsClient,
  type DatadogExternalExperiment,
  type DatadogExternalExperimentSpanInput,
  type DatadogStartExperimentOptions,
} from "#evals/runner/reporters/datadog-client.js";
import { resolveLocalGitMetadata } from "#evals/runner/resolve-git-metadata.js";

/** Configuration for the Datadog reporter. */
export interface DatadogReporterConfig {
  /** Datadog LLM Observability project name. Defaults to `DD_LLMOBS_PROJECT_NAME`, the configured ml_app, `DD_SERVICE`, or the first eval id. */
  readonly projectName?: string;
  /** Dataset reused across runs. Defaults to `<projectName> evals`, or `<experimentName> dataset` without `recordInputs`. */
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
  /** Include the first sent message, falling back to the eval description, in the experiment row and a linked dataset record. Defaults to true. */
  readonly recordInputs?: boolean;
  /** Include eval outputs in the synthetic experiment row output. Defaults to true. */
  readonly recordOutputs?: boolean;
  /** Include `metadata.expectedOutput`, `metadata.expected`, or `metadata.expected_output` on experiment rows. Defaults to true. */
  readonly recordExpectedOutputs?: boolean;
  /** Include each assertion's name and score, and failure messages, in row metadata. Defaults to true. */
  readonly recordAssertionDetails?: boolean;
  /** Include execution error messages, which may contain application data. Defaults to true. */
  readonly recordErrors?: boolean;
  /** Console hook used for tests. */
  readonly log?: (line: string) => void;
  /** eve-owned client seam for tests and custom Datadog SDK wiring. */
  readonly client?: DatadogExperimentsClient;
}

type DatadogRecordingOptions = Required<
  Pick<
    DatadogReporterConfig,
    | "recordInputs"
    | "recordOutputs"
    | "recordExpectedOutputs"
    | "recordAssertionDetails"
    | "recordErrors"
  >
>;

/**
 * Creates an {@link EvalReporter} that uploads eval results to a Datadog LLM
 * Observability Experiment. Requires the optional `dd-trace`
 * package and `DD_API_KEY`/`DD_APP_KEY` credentials unless `config.client` is
 * provided.
 */
export function Datadog(config: DatadogReporterConfig = {}): EvalReporter {
  return new DatadogReporter(config);
}

class DatadogReporter implements EvalReporter {
  readonly #config: DatadogReporterConfig;
  readonly #recording: DatadogRecordingOptions;
  readonly #evaluations = new Map<string, EveEval>();
  #recordKeys = new Map<string, string>();
  #client: DatadogExperimentsClient | undefined;
  #experimentOptions: DatadogStartExperimentOptions | undefined;
  #experiment: DatadogExternalExperiment | undefined;
  #datasetUrl: string | undefined;

  constructor(config: DatadogReporterConfig) {
    this.#config = config;
    this.#recording = {
      recordInputs: config.recordInputs ?? true,
      recordOutputs: config.recordOutputs ?? true,
      recordExpectedOutputs: config.recordExpectedOutputs ?? true,
      recordAssertionDetails: config.recordAssertionDetails ?? true,
      recordErrors: config.recordErrors ?? true,
    };
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
    this.#recordKeys = composeDatasetRecordKeys(evaluations);

    // Without credentials, dd-trace datasets never receive ids.
    if (!this.#config.client && (!process.env.DD_API_KEY || !process.env.DD_APP_KEY)) {
      (this.#config.log ?? console.log)(
        "Datadog reporting skipped: set DD_API_KEY and DD_APP_KEY to upload eval results.\n",
      );
      return;
    }

    const projectName = resolveProjectName(this.#config, evaluations);
    const client = await resolveDatadogClient(this.#config, projectName);
    const git = resolveLocalGitMetadata(process.cwd());

    const experimentName = this.#config.experimentName ?? defaultExperimentName();
    const metadata = resolveExperimentMetadata(evaluations, target);
    if (git.sha) {
      metadata.eveGitCommit = git.sha;
      metadata.eveGitBranch = git.branch;
    }
    Object.assign(metadata, this.#config.metadata);

    const defaultDatasetName = this.#recording.recordInputs
      ? `${projectName} evals`
      : `${experimentName} dataset`;
    const experimentOptions: DatadogStartExperimentOptions = {
      name: experimentName,
      projectName,
      description: this.#config.description,
      dataset: { name: this.#config.datasetName ?? defaultDatasetName },
      tags: resolveExperimentTags(this.#config, target),
      metadata: toDatadogJsonRecord(metadata),
      config: toDatadogJsonRecord(this.#config.config),
    };

    if (this.#recording.recordInputs) {
      if (!client.createDataset || !client.pullDataset) {
        throw new Error(MISSING_DATASET_API_MESSAGE);
      }
      this.#client = client;
      this.#experimentOptions = experimentOptions;
      return;
    }

    this.#experiment = await client.startExperiment(experimentOptions);
  }

  async onEvalComplete(result: EveEvalResult): Promise<void> {
    if (this.#recording.recordInputs || !this.#experiment) return;
    await this.#submitResult(result);
  }

  async onRunComplete(summary: EveEvalRunSummary): Promise<void> {
    try {
      if (this.#recording.recordInputs) {
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
    if (!client || !experimentOptions) return;

    const datasetName = experimentOptions.dataset?.name ?? `${experimentOptions.projectName} evals`;
    const dataset = await getDatadogDataset(client, datasetName, {
      projectName: experimentOptions.projectName,
      description: this.#config.description ?? "eve eval inputs.",
    });

    const recordIndexes = new Map<string, number>();
    for (const [index, record] of dataset.records().entries()) {
      const recordKey = record.metadata[DATASET_RECORD_KEY_METADATA];
      if (typeof recordKey === "string") {
        recordIndexes.set(recordKey, index);
      }
    }

    const newRecords: DatadogDatasetRecordInput[] = [];
    for (const result of results) {
      const nextRecord = this.#composeDatasetRecord(result);
      const index = recordIndexes.get(this.#getRecordKey(result.id));
      if (index === undefined) {
        newRecords.push({
          inputData: nextRecord.input,
          metadata: nextRecord.metadata,
          ...(nextRecord.expectedOutput === null
            ? {}
            : { expectedOutput: nextRecord.expectedOutput }),
        });
        continue;
      }
      const record = dataset.records()[index];
      if (record && !isDatasetRecordEqual(record, nextRecord)) {
        dataset.update(index, nextRecord);
      }
    }
    if (newRecords.length > 0) {
      dataset.addRecords(newRecords);
    }

    await dataset.push();
    const datasetId = dataset.id();
    if (!datasetId) {
      throw new Error(`Datadog dataset '${datasetName}' has no id after push().`);
    }
    const recordIds = new Map<string, string>();
    for (const record of dataset.records()) {
      const recordKey = record.metadata[DATASET_RECORD_KEY_METADATA];
      if (typeof recordKey === "string" && record.id) {
        recordIds.set(recordKey, record.id);
      }
    }

    const datasetOptions: NonNullable<DatadogStartExperimentOptions["dataset"]> = {
      id: datasetId,
      name: dataset.name(),
    };
    // An unchanged pulled dataset has no pinned version.
    const datasetVersion = dataset.version() ?? dataset.latestVersion();
    if (datasetVersion !== null) {
      datasetOptions.version = datasetVersion;
    }
    this.#datasetUrl = dataset.url() ?? undefined;
    this.#experiment = await client.startExperiment({
      ...experimentOptions,
      dataset: datasetOptions,
    });

    for (const result of results) {
      const recordKey = this.#getRecordKey(result.id);
      const datasetRecordId = recordIds.get(recordKey);
      if (!datasetRecordId) {
        throw new Error(
          `Datadog dataset '${datasetName}' has no record id for '${recordKey}' after push().`,
        );
      }
      await this.#submitResult(result, datasetRecordId);
    }
  }

  #getRecordKey(evalId: string): string {
    return this.#recordKeys.get(evalId) ?? evalId;
  }

  #composeDatasetRecord(result: EveEvalResult): DatadogDatasetRecordFields {
    const evaluation = this.#evaluations.get(result.id);
    const expectedOutput = this.#recording.recordExpectedOutputs
      ? toOptionalDatadogJsonValue(resolveExpectedOutput(evaluation))
      : undefined;
    return {
      input: toDatadogJsonValue(resolveInput(result, evaluation)),
      expectedOutput: expectedOutput ?? null,
      metadata: {
        [DATASET_RECORD_KEY_METADATA]: this.#getRecordKey(result.id),
        eveEvalId: result.id,
      },
    };
  }

  async #submitResult(result: EveEvalResult, datasetRecordId?: string): Promise<void> {
    if (!this.#experiment) return;

    const evaluation = this.#evaluations.get(result.id);
    const spanInput: DatadogExternalExperimentSpanInput = {
      name: result.id,
      metadata: toDatadogJsonRecord(
        resolveResultMetadata(result, evaluation, this.#recording.recordAssertionDetails),
      ),
      tags: resolveResultTags(result, evaluation),
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      durationMs: elapsedMs(result.startedAt, result.completedAt),
    };
    if (this.#recording.recordInputs) {
      spanInput.input = toOptionalDatadogJsonValue(resolveInput(result, evaluation));
    }
    if (this.#recording.recordOutputs) {
      spanInput.output = toOptionalDatadogJsonValue(result.result.output);
    }
    if (this.#recording.recordExpectedOutputs) {
      spanInput.expectedOutput = toOptionalDatadogJsonValue(resolveExpectedOutput(evaluation));
    }
    if (this.#recording.recordErrors && result.error !== undefined) {
      spanInput.error = result.error;
    }
    if (datasetRecordId !== undefined) {
      spanInput.datasetRecordId = datasetRecordId;
    }

    const span = await this.#experiment.submitSpan(spanInput);
    await this.#experiment.submitEvaluationMetrics(span, resolveEvaluationMetrics(result));
  }
}

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
const DATASET_RECORD_KEY_METADATA = "eveRecordKey";

// Index-based eval ids shift when cases move, so records are keyed by description.
function composeDatasetRecordKeys(evaluations: readonly EveEval[]): Map<string, string> {
  const keys = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const evaluation of evaluations) {
    const baseKey = evaluation.description?.trim() || evaluation.id;
    const count = (counts.get(baseKey) ?? 0) + 1;
    counts.set(baseKey, count);
    keys.set(evaluation.id, count === 1 ? baseKey : `${baseKey} #${count}`);
  }
  return keys;
}

function isDatasetRecordEqual(
  record: DatadogDatasetRecord,
  fields: DatadogDatasetRecordFields,
): boolean {
  return (
    JSON.stringify(record.input) === JSON.stringify(fields.input) &&
    JSON.stringify(record.expectedOutput ?? null) === JSON.stringify(fields.expectedOutput) &&
    JSON.stringify(record.metadata) === JSON.stringify(fields.metadata)
  );
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
    if (event.type !== "delivery.consumed") continue;
    return event.data.parts;
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
    eveSkillLoads: result.result.derived.skillLoads.map((load) => load.skill),
    eveParked: result.result.derived.parked,
  });
  const runtimeTraceLinks = resolveRuntimeTraceLinks(result.result.traceContexts);
  if (runtimeTraceLinks.length > 0) {
    metadata.experimentRuntimeTraceLinks = runtimeTraceLinks;
  }
  if (recordAssertionDetails) {
    const failedAssertions = result.assertions
      .filter((assertion) => !assertion.passed)
      .map((assertion) => ({ name: assertion.name, message: assertion.message }));
    if (failedAssertions.length > 0) {
      metadata.eveFailedAssertions = failedAssertions;
    }
    metadata.eveAssertionScores = composeAssertionScoreMetadata(result.assertions);
  }
  if (result.result.derived.failureCode) {
    metadata.eveFailureCode = result.result.derived.failureCode;
  }
  return metadata;
}

function resolveEvaluationMetrics(result: EveEvalResult): DatadogEvaluationMetricInput[] {
  const metrics: DatadogEvaluationMetricInput[] = [];
  const usedLabels = new Set<string>(BUILT_IN_METRIC_LABELS);
  const groups = groupAssertionScores(result.assertions, (assertion) =>
    toDatadogMetricLabel(assertion.severity === "gate" ? `gate_${assertion.name}` : assertion.name),
  );

  for (const [label, group] of groups) {
    metrics.push({
      label: reserveDatadogMetricLabel(label, usedLabels),
      value: group.score,
      tags: {
        assertion_severity: group.assertions[0]?.severity ?? "soft",
        assertion_passed: String(group.assertions.every((assertion) => assertion.passed)),
        assertion_count: String(group.assertions.length),
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

  // ISO timestamps have millisecond precision, so fast failures can start and
  // finish in the same millisecond. Datadog Experiment spans require a
  // positive duration; use the smallest representable duration in these units.
  return Math.max(1, completed - start);
}
