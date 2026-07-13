import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "#compiled/zod/index.js";

import {
  BOOTSTRAP_RUNTIME_MODEL_ID,
  BOOTSTRAP_RUNTIME_SYSTEM_PROMPT,
  type RuntimeModelReference,
} from "#runtime/agent/bootstrap.js";
import {
  type AvailableBootstrapTool,
  createMockAuthoredToolInput,
  formatToolOutput,
  resolveMockFixtureToken,
  resolveWeatherCity,
} from "#runtime/agent/mock-model-fixtures.js";
import {
  type BootstrapGenerateResult,
  type BootstrapPrompt,
  createBootstrapGenerateResult,
  createBootstrapStreamResult,
  estimateTokenCount,
  getLastUserPromptText,
  getPromptContentText,
  getPromptText,
} from "#runtime/agent/bootstrap-model-utils.js";
import {
  findRelevantSkill,
  getActivatedSkillIds,
  getAvailableSkills,
} from "#runtime/agent/mock-model-skill-selection.js";
import { createJsonSchemaSample } from "#runtime/agent/mock-structured-output.js";
import { FINAL_OUTPUT_TOOL_NAME } from "#runtime/framework-tools/final-output.js";
import { LOAD_SKILL_TOOL_NAME } from "#runtime/skills/fragment-context.js";

const MOCK_RUNTIME_MODEL_PROVIDER = "eve-runtime-mock";
const LOAD_SKILL_TOOL_CALL_ID = "call_load_skill";
const MOCK_AUTHORED_MODELS_ENV = "EVE_MOCK_AUTHORED_MODELS";
type BootstrapGenerateOptions = Parameters<MockLanguageModelV3["doGenerate"]>[0];

interface BootstrapToolResult {
  readonly isError: boolean;
  readonly output: unknown;
  readonly toolCallId: string;
  readonly toolName: string;
}

const authoredRuntimeModelMocks = new Map<string, LanguageModel>();
const bootstrapWeatherPayloadSchema = z
  .object({
    city: z.string(),
    condition: z.string(),
    summary: z.string(),
    temperatureF: z.number().finite(),
  })
  .strict();

/**
 * Returns true when authored runtime models should resolve through the
 * dedicated deterministic mock adapter. The adapter is internal to the test
 * tiers: unit, integration, and scenario tests activate it through
 * `NODE_ENV=test`; spawned smoke servers use the explicit opt-in environment
 * variable so their package-manager build keeps its normal environment.
 */
export function shouldMockAuthoredRuntimeModels(): boolean {
  return process.env.NODE_ENV === "test" || process.env[MOCK_AUTHORED_MODELS_ENV] === "1";
}

/**
 * Creates a deterministic authored-model mock for one runtime model reference.
 */
export function createMockAuthoredRuntimeModel(reference: RuntimeModelReference): LanguageModel {
  const existingModel = authoredRuntimeModelMocks.get(reference.id);

  if (existingModel !== undefined) {
    return existingModel;
  }

  const model = new MockLanguageModelV3({
    modelId: reference.id,
    provider: MOCK_RUNTIME_MODEL_PROVIDER,
    doGenerate: async (options) => createMockModelResult(options, reference.id),
    doStream: async (options) =>
      createBootstrapStreamResult(createMockModelResult(options, reference.id)),
  });

  authoredRuntimeModelMocks.set(reference.id, model);

  return model;
}

function createMockModelResult(
  options: BootstrapGenerateOptions,
  modelId: string,
): BootstrapGenerateResult {
  const authoredToolResult = getLastAuthoredToolResult(options.prompt);

  if (authoredToolResult !== null) {
    const followUpToolCall = createFollowUpToolCallResult({
      modelId,
      options,
      result: authoredToolResult,
    });
    if (followUpToolCall !== null) {
      return followUpToolCall;
    }
  } else {
    const toolCallResult =
      createSubagentDelegationResult(options, modelId) ??
      createSkillLoadResult(options.prompt, modelId) ??
      createAuthoredToolCallResult(options, modelId);
    if (toolCallResult !== null) {
      return toolCallResult;
    }
  }

  // The model is ready to answer. With the framework `final_output` tool
  // offered, deliver the answer by calling it with a schema-derived sample;
  // otherwise reply in prose.
  const finalOutput = createFinalOutputResult(options, modelId);
  if (finalOutput !== null) {
    return finalOutput;
  }

  const text =
    authoredToolResult !== null
      ? formatToolResultReply(authoredToolResult, options.prompt)
      : createAssistantMessage(options.prompt);

  return createBootstrapGenerateResult({
    inputTokens: estimateTokenCount(getPromptText(options.prompt)),
    modelId,
    outputTokens: estimateTokenCount(text),
    text,
  });
}

/**
 * When the framework `final_output` tool is offered, returns a tool-call result
 * carrying a schema-derived sample — the structured-output analogue of a final
 * text reply. Returns `null` when the tool is absent.
 */
function createFinalOutputResult(
  options: BootstrapGenerateOptions,
  modelId: string,
): BootstrapGenerateResult | null {
  const tool = getAvailableTools(options).find((entry) => entry.name === FINAL_OUTPUT_TOOL_NAME);

  if (tool === undefined) {
    return null;
  }

  const sample = createJsonSchemaSample(tool.inputSchema);

  return createToolCallGenerateResult({
    input: sample,
    inputTokens: estimateTokenCount(getPromptText(options.prompt)),
    modelId,
    outputTokens: estimateTokenCount(JSON.stringify(sample)),
    toolCallId: createToolCallId(FINAL_OUTPUT_TOOL_NAME),
    toolName: FINAL_OUTPUT_TOOL_NAME,
  });
}

/**
 * Resolves the current authored runtime model onto the deterministic mock
 * adapter when the test seam is active.
 */
export function resolveMockAuthoredRuntimeModel(
  reference: RuntimeModelReference,
): LanguageModel | null {
  if (!shouldMockAuthoredRuntimeModels() || reference.id === BOOTSTRAP_RUNTIME_MODEL_ID) {
    return null;
  }

  return createMockAuthoredRuntimeModel(reference);
}

function createSkillLoadResult(
  prompt: BootstrapPrompt,
  modelId: string,
): BootstrapGenerateResult | null {
  const lastUserMessage = getLastUserPromptText(prompt);

  if (lastUserMessage === null || getActivatedSkillIds(prompt).length > 0) {
    return null;
  }

  const skill = findRelevantSkill(getAvailableSkills(prompt), lastUserMessage);

  if (skill === null) {
    return null;
  }

  return createToolCallGenerateResult({
    input: {
      skill: skill.name,
    },
    inputTokens: estimateTokenCount(getPromptText(prompt)),
    modelId,
    outputTokens: estimateTokenCount(skill.name),
    toolCallId: LOAD_SKILL_TOOL_CALL_ID,
    toolName: LOAD_SKILL_TOOL_NAME,
  });
}

const SUBAGENT_TOOL_NAME = "agent";
const SUBAGENT_DELEGATION_DIRECTIVE = /\bdelegate\s+to\s+a\s+subagent\s*:\s*(.+)$/iu;

/**
 * Emits one built-in `agent` tool call when the current user message uses
 * the explicit directive `Delegate to a subagent: <message>`, letting
 * tests exercise a real runtime-action wait. Fires only before the
 * delegated call resolves; then the reply path takes over.
 */
function createSubagentDelegationResult(
  options: BootstrapGenerateOptions,
  modelId: string,
): BootstrapGenerateResult | null {
  const lastUserMessage = getLastUserPromptText(options.prompt);

  if (lastUserMessage === null) {
    return null;
  }

  const directive = SUBAGENT_DELEGATION_DIRECTIVE.exec(lastUserMessage);

  if (directive?.[1] === undefined) {
    return null;
  }

  const tool = getAvailableTools(options).find((entry) => entry.name === SUBAGENT_TOOL_NAME);

  if (tool === undefined) {
    return null;
  }

  const toolInput = { message: directive[1].trim() };

  return createToolCallGenerateResult({
    input: toolInput,
    inputTokens: estimateTokenCount(getPromptText(options.prompt)),
    modelId,
    outputTokens: estimateTokenCount(toolInput.message),
    toolCallId: createToolCallId(SUBAGENT_TOOL_NAME),
    toolName: SUBAGENT_TOOL_NAME,
  });
}

function createAuthoredToolCallResult(
  options: BootstrapGenerateOptions,
  modelId: string,
): BootstrapGenerateResult | null {
  const lastUserMessage = getLastUserPromptText(options.prompt);

  if (lastUserMessage === null) {
    return null;
  }

  const tool = findRelevantTool(getAvailableTools(options), lastUserMessage);

  if (tool === null) {
    return null;
  }

  const city = resolveWeatherCity(lastUserMessage);
  const toolInput = createMockAuthoredToolInput(tool, lastUserMessage, city);

  return createToolCallGenerateResult({
    input: toolInput,
    inputTokens: estimateTokenCount(getPromptText(options.prompt)),
    modelId,
    outputTokens: estimateTokenCount(Object.values(toolInput).join(" ")),
    toolCallId: createToolCallId(tool.name),
    toolName: tool.name,
  });
}

/**
 * Emits a follow-up tool call instead of a text reply when a prior tool
 * result is present and the request names a second tool to run next.
 *
 * This is what lets the authored-model mock drive a multi-step tool loop
 * without a live model. Fixture evals use this to exercise multi-step tool
 * loops by chaining the `lookup-step-a` -> `lookup-step-b` pair: step-a's
 * `stepKey` output becomes step-b's input here.
 * Returns null when there is no next tool, ending the turn with a reply.
 */
function createFollowUpToolCallResult(input: {
  readonly modelId: string;
  readonly options: BootstrapGenerateOptions;
  readonly result: BootstrapToolResult;
}): BootstrapGenerateResult | null {
  const nextTool = findNextExplicitToolAfterResult({
    previousToolName: input.result.toolName,
    prompt: input.options.prompt,
    tools: getAvailableTools(input.options),
  });
  if (nextTool === null) {
    return null;
  }

  const toolInput = createFollowUpToolInput(input.result.output);
  if (toolInput === null) {
    return null;
  }

  return createToolCallGenerateResult({
    input: toolInput,
    inputTokens: estimateTokenCount(getPromptText(input.options.prompt)),
    modelId: input.modelId,
    outputTokens: estimateTokenCount(Object.values(toolInput).join(" ")),
    toolCallId: createToolCallId(nextTool.name),
    toolName: nextTool.name,
  });
}

function createAssistantMessage(prompt: BootstrapPrompt): string {
  const lastUserMessage = getLastUserPromptText(prompt) ?? "Hello from eve";
  const systemLabels = getSystemPromptLabels(prompt);
  const systemProbe = resolveSystemProbe(prompt);
  const fixtureToken = resolveMockFixtureToken(prompt);

  if (fixtureToken !== null) {
    return fixtureToken;
  }

  if (systemLabels.length > 0) {
    if (systemProbe === null) {
      return `Bootstrap reply [${systemLabels.join(", ")}]: ${lastUserMessage}`;
    }

    return `Bootstrap reply [${systemLabels.join(", ")}; probe=${systemProbe}]: ${lastUserMessage}`;
  }

  if (systemProbe !== null) {
    return `Bootstrap reply [probe=${systemProbe}]: ${lastUserMessage}`;
  }

  return `Bootstrap reply: ${lastUserMessage}`;
}

function formatToolResultReply(result: BootstrapToolResult, prompt: BootstrapPrompt): string {
  if (result.isError) {
    return `Local weather tool failed: ${formatToolOutput(result.output)}`;
  }

  if (isWeatherPayload(result.output)) {
    return `Used local weather tool for ${result.output.city}: ${result.output.condition}, ${result.output.temperatureF}F. ${result.output.summary}`;
  }

  const lastUserMessage = getLastUserPromptText(prompt) ?? "Hello from eve";

  return `Used ${result.toolName} for "${lastUserMessage}": ${formatToolOutput(result.output)}`;
}

function createToolCallGenerateResult(input: {
  readonly input: unknown;
  readonly inputTokens: number;
  readonly modelId: string;
  readonly outputTokens: number;
  readonly toolCallId: string;
  readonly toolName: string;
}): BootstrapGenerateResult {
  return {
    content: [
      {
        input: JSON.stringify(input.input),
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        type: "tool-call",
      },
    ],
    finishReason: { raw: undefined, unified: "tool-calls" },
    response: {
      id: "bootstrap-response",
      modelId: input.modelId,
      timestamp: new Date("2026-03-16T00:00:00.000Z"),
    },
    usage: {
      inputTokens: {
        cacheRead: 0,
        cacheWrite: 0,
        noCache: input.inputTokens,
        total: input.inputTokens,
      },
      outputTokens: {
        reasoning: 0,
        text: input.outputTokens,
        total: input.outputTokens,
      },
    },
    warnings: [],
  } as unknown as BootstrapGenerateResult;
}

function getAvailableTools(options: BootstrapGenerateOptions): AvailableBootstrapTool[] {
  return (options.tools ?? []).flatMap((tool) => {
    if (tool.type !== "function") {
      return [];
    }

    return [
      {
        description: tool.description,
        inputSchema: "inputSchema" in tool ? tool.inputSchema : undefined,
        name: tool.name,
        outputSchema: "outputSchema" in tool ? tool.outputSchema : undefined,
      },
    ];
  });
}

function getLastAuthoredToolResult(prompt: BootstrapPrompt): BootstrapToolResult | null {
  for (const message of [...prompt].reverse()) {
    if (message.role === "user") {
      return null;
    }

    if (message.role !== "tool" && message.role !== "assistant") {
      continue;
    }

    for (const part of [...message.content].reverse()) {
      if (typeof part === "string" || part.type !== "tool-result") {
        continue;
      }

      if (part.toolName === LOAD_SKILL_TOOL_NAME) {
        continue;
      }

      return {
        isError:
          part.output.type === "error-json" ||
          part.output.type === "error-text" ||
          part.output.type === "execution-denied",
        output:
          part.output.type === "execution-denied"
            ? {
                reason: part.output.reason ?? null,
                type: part.output.type,
              }
            : part.output.value,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
      };
    }
  }

  return null;
}

function findNextExplicitToolAfterResult(input: {
  readonly previousToolName: string;
  readonly prompt: BootstrapPrompt;
  readonly tools: readonly AvailableBootstrapTool[];
}): AvailableBootstrapTool | null {
  const lastUserMessage = getLastUserPromptText(input.prompt);
  if (lastUserMessage === null) {
    return null;
  }

  const normalizedMessage = normalizeText(lastUserMessage);
  const previousIndex = normalizedMessage.indexOf(normalizeText(input.previousToolName));
  if (previousIndex < 0) {
    return null;
  }

  const candidates = input.tools
    .filter((tool) => tool.name !== input.previousToolName)
    .flatMap((tool) => {
      const index = normalizedMessage.indexOf(normalizeText(tool.name), previousIndex + 1);
      return index < 0 ? [] : [{ index, tool }];
    })
    .sort((left, right) => left.index - right.index);

  return candidates[0]?.tool ?? null;
}

/**
 * Extracts the next tool call's arguments from the previous tool's
 * output, enabling the deterministic `lookup-step-a` -> `lookup-step-b`
 * chain. Only the `stepKey` handoff used by that fixture pair is
 * supported.
 */
function createFollowUpToolInput(output: unknown): Record<string, string> | null {
  if (isRecord(output) && typeof output.stepKey === "string") {
    return { stepKey: output.stepKey };
  }

  return null;
}

function getSystemPromptLabels(prompt: BootstrapPrompt): string[] {
  const systemMessages = prompt.filter((message) => message.role === "system");

  if (systemMessages.length === 0) {
    return [];
  }

  const labels = systemMessages.flatMap((message) => {
    const text = getPromptContentText(message.content);

    if (text.startsWith("Available skills\n")) {
      return [];
    }

    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const extractedLabels: string[] = [];

    for (const line of lines) {
      if (line === BOOTSTRAP_RUNTIME_SYSTEM_PROMPT || line === "Available skills") {
        continue;
      }

      const systemMatch = /^System \((.+)\)$/.exec(line);

      if (systemMatch?.[1]) {
        extractedLabels.push(systemMatch[1]);
        continue;
      }

      const skillMatch = /^Skill \((.+)\)$/.exec(line);

      if (skillMatch?.[1]) {
        extractedLabels.push(skillMatch[1]);
      }
    }

    if (extractedLabels.length > 0) {
      return extractedLabels;
    }

    const fallbackFirstLine = lines.find(
      (line) => line !== BOOTSTRAP_RUNTIME_SYSTEM_PROMPT && line !== "Available skills",
    );

    return fallbackFirstLine === undefined ? [] : [fallbackFirstLine];
  });

  return [...new Set(labels)];
}

function findRelevantTool(
  tools: readonly AvailableBootstrapTool[],
  message: string,
): AvailableBootstrapTool | null {
  const normalizedMessage = normalizeText(message);
  // `load_skill` is reachable only through skill-relevance selection
  // (createSkillLoadResult); matching it by name here would re-call it on
  // every step, because its results are invisible to the tool-result check.
  const explicitTool = tools.find(
    (tool) =>
      tool.name !== "agent" &&
      tool.name !== LOAD_SKILL_TOOL_NAME &&
      normalizedMessage.includes(normalizeText(tool.name)),
  );
  if (explicitTool !== undefined) {
    return explicitTool;
  }

  if (!/\b(forecast|temperature|weather|wind|rain|snow)\b/u.test(normalizedMessage)) {
    return null;
  }

  return (
    tools.find((tool) =>
      /\b(forecast|temperature|weather|wind|rain|snow)\b/u.test(
        normalizeText(`${tool.name} ${tool.description ?? ""}`),
      ),
    ) ?? null
  );
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function createToolCallId(toolName: string): string {
  const normalized = toolName
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return `call_${normalized || "tool"}`;
}

function resolveSystemProbe(prompt: BootstrapPrompt): string | null {
  const systemText = prompt
    .filter((message) => message.role === "system")
    .map((message) => getPromptContentText(message.content))
    .join("\n");
  const probeMatch = /hmr-probe:\s*([^\n]+)/iu.exec(systemText);

  return probeMatch?.[1]?.trim() || null;
}

function isWeatherPayload(value: unknown): value is {
  readonly city: string;
  readonly condition: string;
  readonly summary: string;
  readonly temperatureF: number;
} {
  return bootstrapWeatherPayloadSchema.safeParse(value).success;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
