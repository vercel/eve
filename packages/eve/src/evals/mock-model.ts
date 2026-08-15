import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";

type GenerateOptions = Parameters<MockLanguageModelV3["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>;
type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;
type PromptPart = Exclude<GenerateOptions["prompt"][number]["content"], string>[number];
type ToolResultOutput = Extract<PromptPart, { type: "tool-result" }>["output"];

const DEFAULT_MODEL_ID = "model";
const DEFAULT_PROVIDER = "eve-mock";
const DEFAULT_RESPONSE = "Mock response";
const RESPONSE_TIMESTAMP = Date.parse("2026-01-01T00:00:00.000Z");

/** A text-only view of one message passed to a mock model. */
export interface MockModelMessage {
  /** The message author. */
  readonly role: "assistant" | "system" | "tool" | "user";
  /** Text extracted from the message's content parts. */
  readonly text: string;
}

/** A tool available to a mock model call. */
export interface MockModelTool {
  /** Tool name exposed to the model. */
  readonly name: string;
  /** Authored tool description, when present. */
  readonly description?: string;
  /** JSON Schema describing the tool input, when present. */
  readonly inputSchema?: unknown;
}

/** A completed tool call present in the model prompt. */
export interface MockModelToolResult {
  /** Tool-call identifier. */
  readonly id: string;
  /** Name of the tool that produced the result. */
  readonly name: string;
  /** Normalized tool output. */
  readonly output: unknown;
  /** Whether the tool execution failed or was denied. */
  readonly isError: boolean;
}

/** Normalized input supplied to a {@link MockModelResponder}. */
export interface MockModelRequest {
  /** Every prompt message in order, with text content extracted. */
  readonly messages: readonly MockModelMessage[];
  /** All user-message text in order. */
  readonly userMessages: readonly string[];
  /** The latest user-message text, or `null` before the first user message. */
  readonly lastUserMessage: string | null;
  /** Number of user messages in the prompt. */
  readonly userMessageCount: number;
  /** Tools available for this model call. */
  readonly tools: readonly MockModelTool[];
  /** Tool results already present in the prompt. */
  readonly toolResults: readonly MockModelToolResult[];
}

/** One tool call emitted by a mock model response. */
export interface MockModelToolCall {
  /** Name of the tool to call. */
  readonly name: string;
  /** JSON-serializable tool input. Defaults to an empty object. */
  readonly input?: unknown;
  /** Stable call id. eve derives one when omitted. */
  readonly id?: string;
}

/** Optional token counts reported by a mock response. */
export interface MockModelUsage {
  /** Prompt tokens. eve estimates this value when omitted. */
  readonly inputTokens?: number;
  /** Generated tokens. eve estimates this value when omitted. */
  readonly outputTokens?: number;
}

/** Advanced response shape for text, tool calls, and explicit token usage. */
export interface MockModelResponse {
  /** Assistant text. May be combined with tool calls. */
  readonly text?: string;
  /** Tool calls emitted by the model. */
  readonly toolCalls?: readonly MockModelToolCall[];
  /** Token counts to report instead of eve's deterministic estimates. */
  readonly usage?: MockModelUsage;
}

/** Produces the next deterministic mock-model response. */
export type MockModelResponder = (
  request: MockModelRequest,
) => MockModelResponse | Promise<MockModelResponse | string> | string;

/** Advanced configuration for {@link mockModel}. */
export interface MockModelOptions {
  /** Model id exposed to the agent runtime. Defaults to `"model"`. */
  readonly modelId?: string;
  /** Provider id exposed to the agent runtime. Defaults to `"eve-mock"`. */
  readonly provider?: string;
  /** Static response or callback used for each model call. */
  readonly respond?: MockModelResponder | string;
}

/**
 * Creates a deterministic local language model for an eve eval fixture.
 *
 * Pass a string for a static reply, a callback for prompt-aware behavior, or
 * an options object when the model identity or advanced responses need to be
 * customized. Calling `mockModel()` returns `"Mock response"`.
 *
 * @example
 * ```ts
 * mockModel("Hello from the test agent");
 * mockModel(({ lastUserMessage }) => `Echo: ${lastUserMessage}`);
 * ```
 */
export function mockModel(
  input: MockModelOptions | MockModelResponder | string = {},
): LanguageModel {
  const options = normalizeOptions(input);
  const respond = normalizeResponder(options.respond);
  const modelId = options.modelId ?? DEFAULT_MODEL_ID;

  return new MockLanguageModelV3({
    modelId,
    provider: options.provider ?? DEFAULT_PROVIDER,
    doGenerate: async (callOptions) =>
      createGenerateResult(await respond(createRequest(callOptions)), callOptions, modelId),
    doStream: async (callOptions) =>
      createStreamResult(
        createGenerateResult(await respond(createRequest(callOptions)), callOptions, modelId),
      ),
  });
}

function normalizeOptions(input: MockModelOptions | MockModelResponder | string): MockModelOptions {
  if (typeof input === "string" || typeof input === "function") {
    return { respond: input };
  }

  return input;
}

function normalizeResponder(respond: MockModelOptions["respond"]): MockModelResponder {
  if (typeof respond === "function") {
    return respond;
  }

  const text = respond ?? DEFAULT_RESPONSE;
  return () => text;
}

function createRequest(options: GenerateOptions): MockModelRequest {
  const messages = options.prompt.map((message) => ({
    role: message.role,
    text: extractMessageText(message),
  }));
  const userMessages = messages
    .filter((message) => message.role === "user")
    .map((message) => message.text);

  return {
    lastUserMessage: userMessages.at(-1) ?? null,
    messages,
    toolResults: extractToolResults(options),
    tools: extractTools(options),
    userMessageCount: userMessages.length,
    userMessages,
  };
}

function extractMessageText(message: GenerateOptions["prompt"][number]): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content
    .flatMap((part) => {
      switch (part.type) {
        case "reasoning":
        case "text":
          return [part.text];
        case "tool-result":
          return [formatValue(normalizeToolOutput(part.output))];
        default:
          return [];
      }
    })
    .join("");
}

function extractTools(options: GenerateOptions): readonly MockModelTool[] {
  return (options.tools ?? []).map((tool) => {
    if (tool.type === "function") {
      return {
        description: tool.description,
        inputSchema: tool.inputSchema,
        name: tool.name,
      };
    }

    return { name: tool.name };
  });
}

function extractToolResults(options: GenerateOptions): readonly MockModelToolResult[] {
  return options.prompt.flatMap((message) => {
    if (typeof message.content === "string") {
      return [];
    }

    return message.content.flatMap((part) => {
      if (part.type !== "tool-result") {
        return [];
      }

      return [
        {
          id: part.toolCallId,
          isError:
            part.output.type === "error-json" ||
            part.output.type === "error-text" ||
            part.output.type === "execution-denied",
          name: part.toolName,
          output: normalizeToolOutput(part.output),
        },
      ];
    });
  });
}

function normalizeToolOutput(output: ToolResultOutput): unknown {
  switch (output.type) {
    case "error-json":
    case "error-text":
    case "json":
    case "text":
      return output.value;
    case "execution-denied":
      return output.reason ?? "Tool execution denied";
    case "content":
      return output.value;
  }
}

function createGenerateResult(
  response: MockModelResponse | string,
  options: GenerateOptions,
  modelId: string,
): GenerateResult {
  const normalized = typeof response === "string" ? { text: response } : response;
  const toolCalls = normalized.toolCalls ?? [];

  if (!("text" in normalized) && toolCalls.length === 0) {
    throw new Error('mockModel responders must return text or at least one item in "toolCalls".');
  }

  const content: GenerateResult["content"] = [];

  if (normalized.text !== undefined) {
    content.push({ text: normalized.text, type: "text" });
  }

  for (const [index, toolCall] of toolCalls.entries()) {
    content.push({
      input: JSON.stringify(toolCall.input ?? {}),
      toolCallId:
        toolCall.id ??
        `mock-tool-call-${countUserMessages(options)}-${countToolResults(options)}-${index + 1}`,
      toolName: toolCall.name,
      type: "tool-call",
    });
  }

  const promptText = options.prompt.map((message) => extractMessageText(message)).join(" ");
  const outputText = [
    normalized.text ?? "",
    ...toolCalls.map((toolCall) => formatValue(toolCall.input ?? {})),
  ].join(" ");
  const inputTokens = normalized.usage?.inputTokens ?? estimateTokens(promptText);
  const outputTokens = normalized.usage?.outputTokens ?? estimateTokens(outputText);

  const result: GenerateResult = {
    content,
    finishReason: {
      raw: undefined,
      unified: toolCalls.length > 0 ? "tool-calls" : "stop",
    },
    response: {
      id: `mock-response-${countUserMessages(options)}-${countToolResults(options)}`,
      modelId,
      timestamp: new Date(RESPONSE_TIMESTAMP),
    },
    usage: {
      inputTokens: {
        cacheRead: 0,
        cacheWrite: 0,
        noCache: inputTokens,
        total: inputTokens,
      },
      outputTokens: {
        reasoning: 0,
        text: outputTokens,
        total: outputTokens,
      },
    },
    warnings: [],
  };

  return result;
}

function createStreamResult(result: GenerateResult): StreamResult {
  const chunks: StreamPart[] = [{ type: "stream-start", warnings: result.warnings }];

  if (result.response !== undefined) {
    chunks.push({ ...result.response, type: "response-metadata" });
  }

  let textIndex = 0;

  for (const part of result.content) {
    if (part.type === "text") {
      const id = `mock-text-${textIndex}`;
      textIndex += 1;
      chunks.push({ id, type: "text-start" });
      if (part.text.length > 0) {
        chunks.push({ delta: part.text, id, type: "text-delta" });
      }
      chunks.push({ id, type: "text-end" });
      continue;
    }

    if (part.type === "tool-call") {
      chunks.push(part);
    }
  }

  chunks.push({
    finishReason: result.finishReason,
    type: "finish",
    usage: result.usage,
  });

  return {
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
  };
}

function countUserMessages(options: GenerateOptions): number {
  return options.prompt.filter((message) => message.role === "user").length;
}

function countToolResults(options: GenerateOptions): number {
  return extractToolResults(options).length;
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.trim().length / 4));
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
