import type {
  AgentDefinition,
  AgentBuildDefinition,
  AgentWorkflowDefinition,
} from "#public/definitions/agent.js";
import type { ScheduleDefinition, ScheduleRunHandler } from "#public/definitions/schedule.js";
import type { SkillDefinition, SkillFileContent } from "#public/definitions/skill.js";
import type { InstructionsDefinition } from "#public/definitions/instructions.js";
import {
  expectFunction,
  expectObjectRecord,
  expectOnlyKnownKeys,
  expectProviderOptions,
  expectString,
  getOptionalStringRecordProperty,
} from "#internal/authored-module.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type NormalizedAgentDefinition = Omit<AgentDefinition, "build"> & {
  build?: {
    externalDependencies?: Readonly<AgentBuildDefinition["externalDependencies"]>;
  };
};

/**
 * Normalizes one authored agent definition into the canonical internal shape.
 *
 * Authored `name` fields are rejected — agent identity is derived at compile
 * time from `manifest.agentId` (package name or app-root basename).
 */
export function normalizeAgentDefinition(
  value: unknown,
  message: string,
): Readonly<NormalizedAgentDefinition> {
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(
    record,
    [
      "build",
      "compaction",
      "description",
      "experimental",
      "limits",
      "model",
      "modelContextWindowTokens",
      "modelOptions",
      "outputSchema",
      "reasoning",
    ],
    message,
  );
  if (record.model === undefined) {
    throw new Error(`${message} The "model" field is required.`);
  }

  const definition: Mutable<NormalizedAgentDefinition> = {
    model: record.model as NormalizedAgentDefinition["model"],
  };

  if (record.description !== undefined) {
    definition.description = expectString(record.description, message);
  }

  if (record.compaction !== undefined) {
    definition.compaction = normalizeAgentCompactionDefinition(record.compaction, message);
  }

  if (record.build !== undefined) {
    definition.build = normalizeAgentBuildDefinition(record.build, message);
  }

  if (record.experimental !== undefined) {
    definition.experimental = normalizeAgentExperimentalDefinition(record.experimental, message);
  }

  if (record.modelOptions !== undefined) {
    definition.modelOptions = normalizeAgentModelOptions(record.modelOptions, message);
  }

  if (record.modelContextWindowTokens !== undefined) {
    definition.modelContextWindowTokens = expectPositiveInteger(
      record.modelContextWindowTokens,
      message,
    );
  }

  if (record.outputSchema !== undefined) {
    definition.outputSchema = record.outputSchema as NormalizedAgentDefinition["outputSchema"];
  }

  if (record.reasoning !== undefined) {
    definition.reasoning = normalizeAgentReasoningDefinition(record.reasoning, message);
  }

  if (record.limits !== undefined) {
    definition.limits = normalizeAgentLimitsDefinition(record.limits, message);
  }

  return definition as Readonly<NormalizedAgentDefinition>;
}

function normalizeAgentReasoningDefinition(
  value: unknown,
  message: string,
): NonNullable<NormalizedAgentDefinition["reasoning"]> {
  const reasoning = expectString(value, message);

  switch (reasoning) {
    case "provider-default":
    case "none":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return reasoning;
    default:
      throw new Error(message);
  }
}

function expectPositiveInteger(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(message);
  }

  return value;
}

function normalizeAgentLimitsDefinition(
  value: unknown,
  message: string,
): NonNullable<NormalizedAgentDefinition["limits"]> {
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(record, ["maxSubagentDepth"], message);
  const normalizedDefinition: Mutable<NonNullable<NormalizedAgentDefinition["limits"]>> = {};

  if (record.maxSubagentDepth !== undefined) {
    normalizedDefinition.maxSubagentDepth = expectPositiveInteger(record.maxSubagentDepth, message);
  }

  return normalizedDefinition;
}

function normalizeAgentBuildDefinition(
  value: unknown,
  message: string,
): NonNullable<NormalizedAgentDefinition["build"]> {
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(record, ["externalDependencies"], message);
  const normalizedDefinition: NormalizedAgentDefinition["build"] = {};

  if (record.externalDependencies !== undefined) {
    if (!Array.isArray(record.externalDependencies)) {
      throw new Error(message);
    }

    normalizedDefinition.externalDependencies = Object.freeze(
      record.externalDependencies.map((entry) => expectString(entry, message)),
    );
  }

  return normalizedDefinition;
}

function normalizeAgentWorkflowDefinition(
  value: unknown,
  message: string,
): AgentWorkflowDefinition {
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(record, ["world"], message);
  const normalizedDefinition: Mutable<AgentWorkflowDefinition> = {};

  if (record.world !== undefined) {
    normalizedDefinition.world = normalizeAgentWorkflowWorldDefinition(record.world, message);
  }

  return normalizedDefinition;
}

function normalizeAgentWorkflowWorldDefinition(
  value: unknown,
  message: string,
): NonNullable<AgentWorkflowDefinition["world"]> {
  const packageName = expectString(value, message);
  if (packageName.trim() === "") {
    throw new Error(`${message} "experimental.workflow.world" must be a non-empty package name.`);
  }

  return packageName;
}

function normalizeAgentExperimentalDefinition(
  value: unknown,
  message: string,
): NonNullable<NormalizedAgentDefinition["experimental"]> {
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(record, ["workflow"], message);
  const normalizedDefinition: Mutable<NonNullable<NormalizedAgentDefinition["experimental"]>> = {};

  if (record.workflow !== undefined) {
    normalizedDefinition.workflow = normalizeAgentWorkflowDefinition(record.workflow, message);
  }

  return normalizedDefinition;
}

function normalizeAgentModelOptions(
  value: unknown,
  message: string,
): NonNullable<NormalizedAgentDefinition["modelOptions"]> {
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(record, ["providerOptions"], message);
  const providerOptions = record.providerOptions;

  if (providerOptions === undefined) {
    return {};
  }

  return {
    providerOptions: expectProviderOptions(providerOptions, message),
  };
}

function normalizeAgentCompactionDefinition(
  value: unknown,
  message: string,
): NonNullable<NormalizedAgentDefinition["compaction"]> {
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(record, ["model", "modelContextWindowTokens", "thresholdPercent"], message);
  const normalizedDefinition: Mutable<NonNullable<NormalizedAgentDefinition["compaction"]>> = {};

  if (record.model !== undefined) {
    normalizedDefinition.model = record.model as NormalizedAgentDefinition["model"];
  }

  if (record.modelContextWindowTokens !== undefined) {
    normalizedDefinition.modelContextWindowTokens = expectPositiveInteger(
      record.modelContextWindowTokens,
      message,
    );
  }

  if (record.thresholdPercent !== undefined) {
    const thresholdPercent = record.thresholdPercent;

    if (
      typeof thresholdPercent !== "number" ||
      !Number.isFinite(thresholdPercent) ||
      thresholdPercent < 0 ||
      thresholdPercent > 1
    ) {
      throw new Error(message);
    }

    normalizedDefinition.thresholdPercent = thresholdPercent;
  }

  return normalizedDefinition;
}

/**
 * Normalizes one authored instructions definition into the canonical
 * internal shape.
 *
 * Authored `name` fields are rejected — instructions prompt identity is
 * derived from the file path (`instructions.md` or
 * `instructions.{ts,...}`).
 */
export function normalizeInstructionsDefinition(
  value: unknown,
  message: string,
): InstructionsDefinition & { readonly markdown: string } {
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(record, ["markdown"], message);
  return {
    markdown: expectString(record.markdown, message),
  };
}

/**
 * Normalizes one authored skill definition into the canonical internal
 * shape.
 *
 * Authored `name` fields are rejected — skill identity is derived from
 * the file path under `agent/skills/`.
 */
export function normalizeSkillDefinition(value: unknown, message: string): SkillDefinition {
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(record, ["description", "files", "license", "markdown", "metadata"], message);
  const definition: Mutable<SkillDefinition> = {
    description: expectString(record.description, message),
    markdown: expectString(record.markdown, message),
  };
  const license = record.license;
  const metadata = getOptionalStringRecordProperty(record, "metadata", message);

  if (license !== undefined) {
    definition.license = expectString(license, message);
  }

  if (metadata !== undefined) {
    definition.metadata = metadata;
  }

  if (record.files !== undefined) {
    definition.files = normalizeSkillFiles(record.files, message);
  }

  return definition;
}

function normalizeSkillFiles(
  value: unknown,
  message: string,
): Readonly<Record<string, SkillFileContent>> {
  const files = expectObjectRecord(value, message);
  const normalized: Record<string, SkillFileContent> = {};

  for (const [filePath, content] of Object.entries(files)) {
    if (typeof content === "string" || content instanceof Uint8Array) {
      normalized[filePath] = content;
      continue;
    }

    throw new Error(`${message} Expected skill file "${filePath}" to be a string or Uint8Array.`);
  }

  return normalized;
}

/**
 * Normalizes one authored schedule definition into the canonical internal
 * shape.
 *
 * Authored `name` fields are rejected — schedule identity is derived from
 * the file path under `agent/schedules/`. Exactly one of `markdown` (the
 * fire-and-forget agent prompt) or `run` (the cron handler function)
 * must be provided.
 */
export function normalizeScheduleDefinition(value: unknown, message: string): ScheduleDefinition {
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(record, ["cron", "markdown", "run"], message);

  const cron = expectString(record.cron, message);
  const hasMarkdown = record.markdown !== undefined;
  const hasRun = record.run !== undefined;

  if (hasMarkdown && hasRun) {
    throw new Error(
      `${message} Pass either "markdown" (fire-and-forget) or "run" (handler) — not both.`,
    );
  }
  if (!hasMarkdown && !hasRun) {
    throw new Error(
      `${message} Must provide either "markdown" (fire-and-forget) or "run" (handler).`,
    );
  }

  const definition: { cron: string; markdown?: string; run?: ScheduleRunHandler } = { cron };

  if (hasMarkdown) {
    definition.markdown = expectString(record.markdown, message);
  } else {
    definition.run = expectFunction(record.run, message) as ScheduleRunHandler;
  }

  return definition as ScheduleDefinition;
}
