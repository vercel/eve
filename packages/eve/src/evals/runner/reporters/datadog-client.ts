import { createRequire } from "node:module";

import type ddTrace from "dd-trace";

import { parseJsonValue, type JsonValue } from "#shared/json.js";

// eve-owned seam over the dd-trace LLM Observability experiments API.

export type DatadogJsonValue =
  | string
  | number
  | boolean
  | null
  | DatadogJsonValue[]
  | { [key: string]: DatadogJsonValue };

export interface DatadogDatasetRecordInput {
  inputData: DatadogJsonValue;
  expectedOutput?: DatadogJsonValue;
  metadata?: Record<string, DatadogJsonValue>;
  tags?: string[];
}

export interface DatadogDatasetRecord {
  readonly id: string | null;
  readonly input: DatadogJsonValue;
  readonly expectedOutput: DatadogJsonValue;
  readonly metadata: Record<string, DatadogJsonValue>;
}

export interface DatadogDatasetRecordFields {
  input: DatadogJsonValue;
  expectedOutput: DatadogJsonValue;
  metadata: Record<string, DatadogJsonValue>;
}

export interface DatadogDataset {
  id(): string | null;
  name(): string;
  version(): number | null;
  latestVersion(): number | null;
  records(): readonly DatadogDatasetRecord[];
  addRecords(records: DatadogDatasetRecordInput[]): DatadogDataset;
  update(index: number, fields: Partial<DatadogDatasetRecordFields>): DatadogDataset;
  url(): string | null;
  push(): Promise<{ pushedCount: number; totalCount: number }>;
}

export interface DatadogExperimentsClient {
  createDataset?(
    name: string,
    options?: {
      projectName?: string;
      description?: string;
    },
  ): DatadogDataset;
  pullDataset?(
    name: string,
    options?: { projectName?: string; maxWaitMs?: number },
  ): Promise<DatadogDataset>;
  startExperiment(options: DatadogStartExperimentOptions): Promise<DatadogExternalExperiment>;
}

export interface DatadogStartExperimentOptions {
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

export interface DatadogExternalExperiment {
  experimentId(): string;
  url(): string | null;
  submitSpan(row: DatadogExternalExperimentSpanInput): Promise<DatadogExternalExperimentSpan>;
  submitEvaluationMetrics(
    span: Pick<DatadogExternalExperimentSpan, "experimentId" | "spanId" | "traceId">,
    metrics: DatadogEvaluationMetricInput[],
  ): Promise<void>;
  close(options?: { status?: string; error?: string | Error }): Promise<void>;
}

export interface DatadogExternalExperimentSpanInput {
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

export interface DatadogEvaluationMetricInput {
  label: string;
  value?: DatadogJsonValue;
  error?: string | Error;
  timestamp?: Date | string | number;
  tags?: Record<string, string>;
  source?: string;
}

/** Options used when eve initializes `dd-trace` itself. */
export interface DatadogClientConfig {
  readonly client?: DatadogExperimentsClient;
  readonly service?: string;
  readonly env?: string;
  readonly site?: string;
  readonly mlApp?: string;
}

type DatadogTraceModule = typeof ddTrace;

const DD_TRACE_PACKAGE = "dd-trace";
const DATASET_PULL_MAX_WAIT_MS = 5_000;
export const MISSING_DATASET_API_MESSAGE = [
  "The installed 'dd-trace' package does not expose tracer.llmobs.experiments.createDataset() and pullDataset().",
  "Update to a release compatible with dd-trace@6.13.0.",
].join("\n");

/** Pulls the named dataset, creating it when Datadog has no dataset with that name. */
export async function getDatadogDataset(
  client: DatadogExperimentsClient,
  name: string,
  options: { projectName?: string; description: string },
): Promise<DatadogDataset> {
  if (!client.pullDataset || !client.createDataset) {
    throw new Error(MISSING_DATASET_API_MESSAGE);
  }
  try {
    return await client.pullDataset(name, {
      projectName: options.projectName,
      maxWaitMs: DATASET_PULL_MAX_WAIT_MS,
    });
  } catch (error) {
    // dd-trace reports a missing dataset only through this message.
    if (!(error instanceof Error) || !error.message.startsWith(`Dataset '${name}' not found`)) {
      throw error;
    }
  }
  return client.createDataset(name, options);
}

/** Returns `config.client`, or initializes `dd-trace` and returns its experiments API. */
export async function resolveDatadogClient(
  config: DatadogClientConfig,
  projectName: string,
): Promise<DatadogExperimentsClient> {
  if (config.client) return config.client;

  const sdk = await loadDatadogSdk();
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

export function toOptionalDatadogJsonValue(value: unknown): DatadogJsonValue | undefined {
  return value === undefined ? undefined : toDatadogJsonValue(value);
}

export function toDatadogJsonRecord(
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

export function toDatadogJsonValue(value: unknown): DatadogJsonValue {
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
