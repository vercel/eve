import { PROGRAM_MAX_AGENT_CALLS, PROGRAM_MAX_OUTPUT_BYTES } from "#execution/code-mode/limits.js";
import { isAgentReasoningDefinition } from "#internal/runtime-model.js";
import type {
  InteractionDisplay,
  InteractionOption,
  InteractionOptionStyle,
} from "#protocol/session-events/families/interaction.js";
import {
  ANTHROPIC_PROMPT_CACHE_TTLS,
  type AgentModelOptionsDefinition,
  type AgentPromptCacheDefinition,
  type AnthropicPromptCacheTtl,
} from "#shared/agent-definition.js";
import {
  isJsonObjectValue,
  parseJsonObject,
  parseJsonValue,
  type JsonObject,
  type JsonValue,
} from "#shared/json.js";
import { MAX_MESSAGE_PARTS } from "#shared/message-content.js";
import type { ToolQuestion } from "#tools/definition.js";
import type { AgentSessionModelSelection } from "#tools/workflow-definition.js";

export const DEFAULT_WORKFLOW_PROGRAM_MAX_SUBAGENTS = 100;
export const MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS = PROGRAM_MAX_AGENT_CALLS;
export const WORKFLOW_PROGRAM_MAX_AGENT_OUTPUT_BYTES = PROGRAM_MAX_OUTPUT_BYTES;
export const WORKFLOW_PROGRAM_MAX_SLEEP_SECONDS = 365 * 24 * 60 * 60;

export type WorkflowProgramAgents = Readonly<Record<string, { readonly description: string }>>;

export interface WorkflowProgramContinuationSecurity {
  readonly maxAgeMs?: number;
  readonly signingKey: string;
}

export interface WorkflowProgramInput {
  readonly agents?: WorkflowProgramAgents;
  readonly continuationSecurity: WorkflowProgramContinuationSecurity;
  readonly js: string;
  readonly maxSubagents: number;
}

export interface WorkflowProgramOptions {
  readonly maxSubagents: number;
  readonly tools?: true;
}

export interface WorkflowProgramAgentFile {
  readonly filename?: string;
  readonly mediaType: string;
  readonly url: string;
}

export interface WorkflowProgramAgentCall {
  readonly input: {
    readonly files?: readonly WorkflowProgramAgentFile[];
    readonly message: string;
    readonly model?: AgentSessionModelSelection;
    readonly outputSchema?: JsonObject;
  };
  readonly target: string;
}

export type WorkflowProgramAction =
  | ({ readonly kind: "agent" } & WorkflowProgramAgentCall)
  | { readonly kind: "ask"; readonly request: ToolQuestion }
  | { readonly kind: "sleep"; readonly seconds: number };

export interface WorkflowProgramPendingAction {
  readonly action: WorkflowProgramAction;
  readonly id: string;
}

export type WorkflowProgramCallResult =
  | { readonly output: JsonValue; readonly status: "completed" }
  | { readonly error: string; readonly status: "failed" };

export interface WorkflowProgramResolution {
  readonly interruptionId: string;
  readonly value: WorkflowProgramCallResult;
}

const AGENT_INPUT_KEYS = new Set(["files", "message", "model", "outputSchema"]);
const MODEL_SELECTION_KEYS = new Set([
  "model",
  "modelContextWindowTokens",
  "modelOptions",
  "reasoning",
]);
const MODEL_OPTIONS_KEYS = new Set(["promptCache", "providerOptions"]);
const FILE_KEYS = new Set(["filename", "mediaType", "url"]);
const ASK_KEYS = new Set([
  "allowFreeform",
  "display",
  "initialOptionId",
  "options",
  "prompt",
  "title",
]);
const ASK_OPTION_KEYS = new Set(["description", "id", "label", "style"]);
const ASK_DISPLAYS = new Set<InteractionDisplay>(["confirmation", "select", "text"]);
const ASK_OPTION_STYLES = new Set<InteractionOptionStyle>(["danger", "default", "primary"]);

export function parseWorkflowProgramOptions(value: unknown): WorkflowProgramOptions {
  const input = parseJsonObject(value);
  if (
    !isPositiveInteger(input.maxSubagents) ||
    input.maxSubagents > MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS
  ) {
    throw new TypeError(
      `workflow maxSubagents must be an integer between 1 and ${String(MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS)}.`,
    );
  }
  if (input.tools !== undefined && typeof input.tools !== "boolean") {
    throw new TypeError("workflow tools must be a boolean.");
  }
  return input.tools === true
    ? { maxSubagents: input.maxSubagents, tools: true }
    : { maxSubagents: input.maxSubagents };
}

export function readWorkflowProgramAgentCall(value: unknown): WorkflowProgramAgentCall {
  const call = parseJsonObject(value);
  if (typeof call.target !== "string" || call.target.trim() === "") {
    throw new TypeError("Workflow program ctx.agent() requires a non-empty agent name.");
  }
  const rawInput = parseJsonObject(call.input);
  if (typeof rawInput.message !== "string") {
    throw new TypeError('Workflow program ctx.agent() requires a "message" string.');
  }
  assertKnownKeys(rawInput, AGENT_INPUT_KEYS, "Workflow program ctx.agent()");
  const input: {
    files?: readonly WorkflowProgramAgentFile[];
    message: string;
    model?: AgentSessionModelSelection;
    outputSchema?: JsonObject;
  } = { message: rawInput.message };
  if (rawInput.outputSchema !== undefined) {
    input.outputSchema = parseJsonObject(rawInput.outputSchema);
  }
  if (rawInput.model !== undefined) {
    input.model = readWorkflowProgramModelSelection(rawInput.model);
  }
  if (rawInput.files !== undefined) {
    input.files = readWorkflowProgramAgentFiles(rawInput.files);
  }
  return { input, target: call.target };
}

export function readWorkflowProgramAskRequest(value: unknown): ToolQuestion {
  const raw = parseJsonObject(value);
  assertKnownKeys(raw, ASK_KEYS, "Workflow program ctx.ask()");
  if (typeof raw.prompt !== "string" || raw.prompt.trim() === "") {
    throw new TypeError('Workflow program ctx.ask() requires a non-empty "prompt" string.');
  }
  const request: {
    allowFreeform?: boolean;
    display?: InteractionDisplay;
    initialOptionId?: string;
    options?: readonly InteractionOption[];
    prompt: string;
    title?: string;
  } = { prompt: raw.prompt };

  if (raw.title !== undefined) {
    if (typeof raw.title !== "string") {
      throw new TypeError('Workflow program ctx.ask() "title" must be a string.');
    }
    request.title = raw.title;
  }
  if (raw.display !== undefined) {
    if (typeof raw.display !== "string" || !ASK_DISPLAYS.has(raw.display as InteractionDisplay)) {
      throw new TypeError(
        'Workflow program ctx.ask() "display" must be "confirmation", "select", or "text".',
      );
    }
    request.display = raw.display as InteractionDisplay;
  }
  if (raw.allowFreeform !== undefined) {
    if (typeof raw.allowFreeform !== "boolean") {
      throw new TypeError('Workflow program ctx.ask() "allowFreeform" must be a boolean.');
    }
    request.allowFreeform = raw.allowFreeform;
  }
  if (raw.options !== undefined) {
    if (!Array.isArray(raw.options)) {
      throw new TypeError('Workflow program ctx.ask() "options" must be an array.');
    }
    request.options = raw.options.map((entry) => readAskOption(entry));
  }
  if (raw.initialOptionId !== undefined) {
    if (typeof raw.initialOptionId !== "string") {
      throw new TypeError('Workflow program ctx.ask() "initialOptionId" must be a string.');
    }
    if (
      request.display === "select" &&
      !request.options?.some((option) => option.id === raw.initialOptionId)
    ) {
      throw new TypeError(
        `Workflow program ctx.ask() "initialOptionId" ${JSON.stringify(raw.initialOptionId)} must match one of the question's option ids.`,
      );
    }
    request.initialOptionId = raw.initialOptionId;
  }
  return request;
}

export function readWorkflowProgramSleepSeconds(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > WORKFLOW_PROGRAM_MAX_SLEEP_SECONDS
  ) {
    throw new RangeError(
      `Workflow program ctx.sleep() requires a finite number of seconds greater than 0 and at most ${String(WORKFLOW_PROGRAM_MAX_SLEEP_SECONDS)}.`,
    );
  }
  return value;
}

export function readWorkflowProgramProgressUpdate(value: unknown): JsonValue {
  return parseJsonValue(value);
}

function readWorkflowProgramModelSelection(value: unknown): AgentSessionModelSelection {
  if (typeof value === "string") {
    if (value.trim() === "") {
      throw new TypeError('Workflow program ctx.agent() "model" must be a non-empty string.');
    }
    return value;
  }
  const raw = parseJsonObject(value);
  assertKnownKeys(raw, MODEL_SELECTION_KEYS, 'Workflow program ctx.agent() "model"');
  if (typeof raw.model !== "string" || raw.model.trim() === "") {
    throw new TypeError(
      'Workflow program ctx.agent() "model" object requires a non-empty "model" string.',
    );
  }
  const selection: {
    model: string;
    modelContextWindowTokens?: number;
    modelOptions?: AgentModelOptionsDefinition;
    reasoning?: ReturnType<typeof readReasoning>;
  } = { model: raw.model };

  if (raw.modelContextWindowTokens !== undefined) {
    if (!isPositiveInteger(raw.modelContextWindowTokens)) {
      throw new TypeError(
        'Workflow program ctx.agent() "model.modelContextWindowTokens" must be a positive integer.',
      );
    }
    selection.modelContextWindowTokens = raw.modelContextWindowTokens;
  }
  if (raw.reasoning !== undefined) {
    selection.reasoning = readReasoning(raw.reasoning);
  }
  if (raw.modelOptions !== undefined) {
    selection.modelOptions = readModelOptions(raw.modelOptions);
  }
  return selection;
}

function readReasoning(value: unknown) {
  if (!isAgentReasoningDefinition(value)) {
    throw new TypeError(
      'Workflow program ctx.agent() "model.reasoning" must be provider-default, none, minimal, low, medium, high, or xhigh.',
    );
  }
  return value;
}

function readModelOptions(value: unknown): AgentModelOptionsDefinition {
  const raw = parseJsonObject(value);
  assertKnownKeys(raw, MODEL_OPTIONS_KEYS, 'Workflow program ctx.agent() "model.modelOptions"');
  const options: {
    promptCache?: AgentPromptCacheDefinition;
    providerOptions?: Record<string, JsonObject>;
  } = {};

  if (raw.providerOptions !== undefined) {
    const record = parseJsonObject(raw.providerOptions);
    const providerOptions: Record<string, JsonObject> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (!isJsonObjectValue(entry)) {
        throw new TypeError(
          `Workflow program ctx.agent() "model.modelOptions.providerOptions.${key}" must be an object.`,
        );
      }
      providerOptions[key] = entry;
    }
    options.providerOptions = providerOptions;
  }

  if (raw.promptCache !== undefined) {
    const promptCache = parseJsonObject(raw.promptCache);
    assertKnownKeys(
      promptCache,
      new Set(["anthropic"]),
      'Workflow program ctx.agent() "model.modelOptions.promptCache"',
    );
    if (promptCache.anthropic === undefined) {
      options.promptCache = {};
    } else {
      const anthropic = parseJsonObject(promptCache.anthropic);
      assertKnownKeys(
        anthropic,
        new Set(["ttl"]),
        'Workflow program ctx.agent() "model.modelOptions.promptCache.anthropic"',
      );
      if (anthropic.ttl === undefined) {
        options.promptCache = { anthropic: {} };
      } else if (
        typeof anthropic.ttl !== "string" ||
        !ANTHROPIC_PROMPT_CACHE_TTLS.includes(anthropic.ttl as AnthropicPromptCacheTtl)
      ) {
        throw new TypeError(
          'Workflow program ctx.agent() "model.modelOptions.promptCache.anthropic.ttl" must be "5m" or "1h".',
        );
      } else {
        options.promptCache = { anthropic: { ttl: anthropic.ttl as AnthropicPromptCacheTtl } };
      }
    }
  }

  return options;
}

function readWorkflowProgramAgentFiles(value: unknown): readonly WorkflowProgramAgentFile[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Workflow program ctx.agent() "files" must be an array.');
  }
  if (value.length > MAX_MESSAGE_PARTS - 1) {
    throw new RangeError(
      `Workflow program ctx.agent() accepts at most ${String(MAX_MESSAGE_PARTS - 1)} files.`,
    );
  }
  return value.map((entry): WorkflowProgramAgentFile => {
    const raw = parseJsonObject(entry);
    assertKnownKeys(raw, FILE_KEYS, 'Workflow program ctx.agent() "files" entry');
    if (typeof raw.url !== "string") {
      throw new TypeError(
        'Workflow program ctx.agent() file entries require an HTTP(S) "url" string.',
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(raw.url);
    } catch {
      throw new TypeError(
        'Workflow program ctx.agent() file entries require an HTTP(S) "url", not inline bytes or base64.',
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new TypeError(
        'Workflow program ctx.agent() file entries require an HTTP(S) "url", not inline bytes or base64.',
      );
    }
    if (typeof raw.mediaType !== "string" || raw.mediaType.trim() === "") {
      throw new TypeError(
        'Workflow program ctx.agent() file entries require a non-empty "mediaType" string.',
      );
    }
    if (
      raw.filename !== undefined &&
      (typeof raw.filename !== "string" || raw.filename.trim() === "")
    ) {
      throw new TypeError(
        'Workflow program ctx.agent() file entry "filename" must be a non-empty string.',
      );
    }
    return raw.filename === undefined
      ? { mediaType: raw.mediaType, url: raw.url }
      : { filename: raw.filename, mediaType: raw.mediaType, url: raw.url };
  });
}

function readAskOption(value: unknown): InteractionOption {
  const raw = parseJsonObject(value);
  assertKnownKeys(raw, ASK_OPTION_KEYS, 'Workflow program ctx.ask() "options" entry');
  if (typeof raw.id !== "string" || raw.id.trim() === "") {
    throw new TypeError('Workflow program ctx.ask() options require a non-empty "id" string.');
  }
  if (typeof raw.label !== "string" || raw.label.trim() === "") {
    throw new TypeError('Workflow program ctx.ask() options require a non-empty "label" string.');
  }
  const option: {
    description?: string;
    id: string;
    label: string;
    style?: InteractionOptionStyle;
  } = { id: raw.id, label: raw.label };
  if (raw.description !== undefined) {
    if (typeof raw.description !== "string") {
      throw new TypeError('Workflow program ctx.ask() option "description" must be a string.');
    }
    option.description = raw.description;
  }
  if (raw.style !== undefined) {
    if (
      typeof raw.style !== "string" ||
      !ASK_OPTION_STYLES.has(raw.style as InteractionOptionStyle)
    ) {
      throw new TypeError(
        'Workflow program ctx.ask() option "style" must be "primary", "danger", or "default".',
      );
    }
    option.style = raw.style as InteractionOptionStyle;
  }
  return option;
}

function assertKnownKeys(record: JsonObject, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new TypeError(`${label} does not accept unknown field "${unknown}".`);
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
