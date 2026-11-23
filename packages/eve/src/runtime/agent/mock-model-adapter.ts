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
  isFrameworkAnnouncementText,
} from "#runtime/agent/bootstrap-model-utils.js";
import {
  findRelevantSkill,
  getActivatedSkillIds,
  getAvailableSkills,
  getSkillLoads,
} from "#runtime/agent/mock-model-skill-selection.js";
import { createJsonSchemaSample } from "#runtime/agent/mock-structured-output.js";
import { REPLY_TOOL_NAME } from "#protocol/reply-tool.js";
import { readTaskResults } from "#execution/tasks/render.js";
import { SKILL_TOOL_NAME } from "#protocol/catalog-tools.js";
import { fromBase64 } from "#shared/bytes.js";
import { sha256Hex } from "#shared/digest.js";
import { readEnv } from "#runtime-env/env.js";

const MOCK_RUNTIME_MODEL_PROVIDER = "eve-runtime-mock";
const SKILL_LOAD_CALL_ID = "call_execute_skill";
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

export function shouldMockAuthoredRuntimeModels(): boolean {
  return process.env.NODE_ENV === "test" || readEnv(MOCK_AUTHORED_MODELS_ENV) === "1";
}

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
      createParallelAuthoredToolCallsResult(options, modelId) ??
      createSubagentDelegationResult(options, modelId) ??
      createSkillLoadResult(options.prompt, modelId) ??
      createAuthoredToolCallResult(options, modelId);
    if (toolCallResult !== null) {
      return toolCallResult;
    }
  }

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

function createFinalOutputResult(
  options: BootstrapGenerateOptions,
  modelId: string,
): BootstrapGenerateResult | null {
  const tool = getAvailableTools(options).find((entry) => entry.name === REPLY_TOOL_NAME);

  if (tool === undefined) {
    return null;
  }

  const sample = createJsonSchemaSample(tool.inputSchema);

  return createToolCallGenerateResult({
    input: sample,
    inputTokens: estimateTokenCount(getPromptText(options.prompt)),
    modelId,
    outputTokens: estimateTokenCount(JSON.stringify(sample)),
    toolCallId: createToolCallId(REPLY_TOOL_NAME),
    toolName: REPLY_TOOL_NAME,
  });
}

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
      name: skill.name,
    },
    inputTokens: estimateTokenCount(getPromptText(prompt)),
    modelId,
    outputTokens: estimateTokenCount(skill.name),
    toolCallId: SKILL_LOAD_CALL_ID,
    toolName: SKILL_TOOL_NAME,
  });
}

const SUBAGENT_TOOL_NAME = "agent";
const SUBAGENT_DELEGATION_DIRECTIVE = /\bdelegate\s+to\s+a\s+subagent\s*:\s*(.+)$/iu;
const PARALLEL_AUTHORED_TOOLS_DIRECTIVE = /^call tools in parallel:\s*(.+)$/imu;

function createParallelAuthoredToolCallsResult(
  options: BootstrapGenerateOptions,
  modelId: string,
): BootstrapGenerateResult | null {
  const lastUserMessage = getLastUserPromptText(options.prompt);
  if (lastUserMessage === null) {
    return null;
  }

  const directive = PARALLEL_AUTHORED_TOOLS_DIRECTIVE.exec(lastUserMessage);
  const requestedNames = directive?.[1]
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  if (requestedNames === undefined || requestedNames.length < 2) {
    return null;
  }
  if (new Set(requestedNames).size !== requestedNames.length) {
    return null;
  }

  const availableTools = new Map(getAvailableTools(options).map((tool) => [tool.name, tool]));
  const requestedTools: AvailableBootstrapTool[] = [];
  for (const name of requestedNames) {
    const tool = availableTools.get(name);
    if (tool === undefined) {
      return null;
    }
    requestedTools.push(tool);
  }

  const city = resolveWeatherCity(lastUserMessage);
  return createToolCallsGenerateResult({
    calls: requestedTools.map((tool) => ({
      input: createMockAuthoredToolInput(tool, lastUserMessage, city),
      toolCallId: createToolCallId(tool.name),
      toolName: tool.name,
    })),
    inputTokens: estimateTokenCount(getPromptText(options.prompt)),
    modelId,
    outputTokens: estimateTokenCount(lastUserMessage),
  });
}

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

  const toolName = SUBAGENT_TOOL_NAME;
  const tool = getAvailableTools(options).find((entry) => entry.name === toolName);

  if (tool === undefined) {
    return null;
  }

  const message = directive[1].trim();

  return createToolCallGenerateResult({
    input: { message },
    inputTokens: estimateTokenCount(getPromptText(options.prompt)),
    modelId,
    outputTokens: estimateTokenCount(message),
    toolCallId: createToolCallId(toolName),
    toolName,
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

const LIST_ATTACHMENTS_DIRECTIVE = /\blist the attachments\b/iu;

function createAssistantMessage(prompt: BootstrapPrompt): string {
  const lastUserMessage = getLastUserPromptText(prompt) ?? "Hello from eve";
  if (LIST_ATTACHMENTS_DIRECTIVE.test(lastUserMessage)) {
    return `Attachments: ${JSON.stringify(listPromptAttachments(prompt))}`;
  }
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
  return createToolCallsGenerateResult({
    calls: [
      {
        input: input.input,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
      },
    ],
    inputTokens: input.inputTokens,
    modelId: input.modelId,
    outputTokens: input.outputTokens,
  });
}

function createToolCallsGenerateResult(input: {
  readonly calls: readonly {
    readonly input: unknown;
    readonly toolCallId: string;
    readonly toolName: string;
  }[];
  readonly inputTokens: number;
  readonly modelId: string;
  readonly outputTokens: number;
}): BootstrapGenerateResult {
  return {
    content: input.calls.map((call) => ({
      input: JSON.stringify(call.input),
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      type: "tool-call",
    })),
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
  const skillLoads = getSkillLoads(prompt);
  for (const message of [...prompt].reverse()) {
    if (message.role === "user") {
      const text = getPromptContentText(message.content).trim();
      const task = readTaskResults(text).at(-1);
      if (task !== undefined) {
        const { body: output, taskId: toolCallId, tool: toolName } = task;
        return { isError: task.status === "failed", output, toolCallId, toolName };
      }
      if (isFrameworkAnnouncementText(text)) continue;
      return null;
    }

    if (message.role !== "tool" && message.role !== "assistant") {
      continue;
    }

    for (const part of [...message.content].reverse()) {
      if (typeof part === "string" || part.type !== "tool-result") {
        continue;
      }

      if (skillLoads.has(part.toolCallId)) {
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
  const explicitTool = tools.find(
    (tool) => tool.name !== "agent" && normalizedMessage.includes(normalizeText(tool.name)),
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
  return z.validate(bootstrapWeatherPayloadSchema, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ATTACHMENT_NOTE = /^Attachment\b/u;

function listPromptAttachments(prompt: BootstrapPrompt): readonly Record<string, unknown>[] {
  return prompt.flatMap((message): Record<string, unknown>[] => {
    if (message.role !== "user" || typeof message.content === "string") return [];
    return message.content.flatMap((part): Record<string, unknown>[] => {
      if (typeof part === "string") return [];
      if (part.type === "text") {
        return ATTACHMENT_NOTE.test(part.text) ? [{ note: part.text.replaceAll('"', "'") }] : [];
      }
      if (part.type !== "file") return [];
      const name = part.filename?.split("/").at(-1) ?? null;
      const data = fileData(part.data);
      if (data instanceof URL) return [{ mediaType: part.mediaType, name, url: data.href }];
      if (data === undefined) return [{ mediaType: part.mediaType, name }];
      const bytes = typeof data === "string" ? fromBase64(data) : data;
      return [
        {
          bytes: bytes.length,
          mediaType: part.mediaType,
          name,
          sha256: sha256Hex(bytes).slice(0, 16),
        },
      ];
    });
  });
}

function fileData(data: unknown): Uint8Array | string | URL | undefined {
  if (typeof data === "string" || data instanceof Uint8Array || data instanceof URL) return data;
  if (typeof data !== "object" || data === null) return undefined;
  const tagged = data as {
    readonly data?: unknown;
    readonly type?: unknown;
    readonly url?: unknown;
  };
  if (tagged.type === "url" && tagged.url instanceof URL) return tagged.url;
  if (tagged.type === "data") return fileData(tagged.data);
  return undefined;
}
