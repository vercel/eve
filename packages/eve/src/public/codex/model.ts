import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
  SharedV3Warning,
} from "@ai-sdk/provider";

import { createCodexAppServerSession } from "#public/codex/app-server.js";
import {
  codexOutputSchema,
  mapCodexTools,
  renderCodexPrompt,
  stringifyCodexJson,
} from "#public/codex/prompt.js";
import type {
  CodexAppServerInput,
  CodexAppServerListener,
  CodexAppServerSession,
  CodexAppServerSessionFactory,
  CodexAppServerToolCall,
  CodexAppServerUsage,
  CodexDynamicTool,
} from "#public/codex/types.js";

const CODEX_DYNAMIC_TOOL_NAMESPACE = null;
const UNKNOWN_USAGE: LanguageModelV3Usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: undefined,
    total: undefined,
  },
  outputTokens: {
    reasoning: undefined,
    text: undefined,
    total: undefined,
  },
};

/** Configures the model selected by the local Codex CLI. */
export interface CodexSubscriptionModelOptions {
  /** Codex model ID passed to `thread/start`, for example `gpt-5.2-codex`. */
  readonly model: string;
}

/** Creates a local, subscription-authenticated AI SDK model through the Codex CLI. */
export function experimental_codex(input: CodexSubscriptionModelOptions): LanguageModelV3 {
  return createCodexSubscriptionModelWithSessionFactory(input, createCodexAppServerSession);
}

// Test seam for the app-server process boundary.
export function createCodexSubscriptionModelWithSessionFactory(
  input: CodexSubscriptionModelOptions,
  createSession: CodexAppServerSessionFactory,
): LanguageModelV3 {
  const model = input.model.trim();
  if (model.length === 0) {
    throw new Error('Expected "model" to name a Codex model.');
  }
  return new CodexSubscriptionModel(model, createSession);
}

class CodexSubscriptionModel implements LanguageModelV3 {
  readonly modelId: string;
  readonly provider = "codex";
  readonly specificationVersion = "v3" as const;
  readonly supportedUrls = {};

  readonly #createSession: CodexAppServerSessionFactory;

  constructor(model: string, createSession: CodexAppServerSessionFactory) {
    this.modelId = model;
    this.#createSession = createSession;
  }

  readonly doGenerate: LanguageModelV3["doGenerate"] = async (
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3GenerateResult> => {
    const { stream } = await this.doStream(options);
    const reader = stream.getReader();
    const content: LanguageModelV3Content[] = [];
    const textById = new Map<string, string>();
    let finishReason: LanguageModelV3GenerateResult["finishReason"] | undefined;
    let usage = UNKNOWN_USAGE;
    let warnings: SharedV3Warning[] = [];

    for (;;) {
      const next = await reader.read();
      if (next.done) break;

      switch (next.value.type) {
        case "stream-start":
          warnings = next.value.warnings;
          break;
        case "text-start":
          textById.set(next.value.id, "");
          break;
        case "text-delta":
          textById.set(next.value.id, `${textById.get(next.value.id) ?? ""}${next.value.delta}`);
          break;
        case "text-end": {
          const text = textById.get(next.value.id);
          if (text !== undefined) {
            content.push({ text, type: "text" });
          }
          break;
        }
        case "tool-call":
          content.push({
            input: next.value.input,
            toolCallId: next.value.toolCallId,
            toolName: next.value.toolName,
            type: "tool-call",
          });
          break;
        case "finish":
          finishReason = next.value.finishReason;
          usage = next.value.usage;
          break;
        case "error":
          throw next.value.error;
        default:
          break;
      }
    }

    if (finishReason === undefined) {
      throw new Error("Codex app-server ended without a model finish event.");
    }

    return { content, finishReason, usage, warnings };
  };

  readonly doStream: LanguageModelV3["doStream"] = async (
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> => {
    const response = new CodexSubscriptionResponse({
      createSession: this.#createSession,
      model: this.modelId,
      options,
    });
    response.start();
    return { stream: response.stream };
  };
}

class CodexSubscriptionResponse implements CodexAppServerListener {
  readonly stream: ReadableStream<LanguageModelV3StreamPart>;

  readonly #input: readonly CodexAppServerInput[];
  readonly #model: string;
  readonly #options: LanguageModelV3CallOptions;
  readonly #session: CodexAppServerSession;
  readonly #tools: readonly CodexDynamicTool[];
  readonly #toolNames: ReadonlySet<string>;
  readonly #warnings: readonly SharedV3Warning[];

  #abortHandler: (() => void) | undefined;
  #closed = false;
  #controller: ReadableStreamDefaultController<LanguageModelV3StreamPart> | undefined;
  #openTextIds = new Set<string>();
  #usage = UNKNOWN_USAGE;

  constructor(input: {
    readonly createSession: CodexAppServerSessionFactory;
    readonly model: string;
    readonly options: LanguageModelV3CallOptions;
  }) {
    const mappedTools = mapCodexTools(input.options.tools, input.options.toolChoice);
    this.#input = renderCodexPrompt(input.options.prompt, input.options.toolChoice);
    this.#model = input.model;
    this.#options = input.options;
    this.#session = input.createSession();
    this.#tools = mappedTools.tools;
    this.#toolNames = new Set(mappedTools.tools.map((tool) => tool.name));
    this.#warnings = mappedTools.warnings;
    this.stream = new ReadableStream<LanguageModelV3StreamPart>({
      cancel: () => {
        this.#cancel();
      },
      start: (controller) => {
        this.#controller = controller;
        controller.enqueue({ type: "stream-start", warnings: [...this.#warnings] });
      },
    });
  }

  start(): void {
    const signal = this.#options.abortSignal;
    if (signal?.aborted) {
      this.onError(new Error("Codex model call was aborted."));
      return;
    }
    if (signal !== undefined) {
      this.#abortHandler = () => {
        this.onError(new Error("Codex model call was aborted."));
      };
      signal.addEventListener("abort", this.#abortHandler, { once: true });
    }

    void this.#session
      .start({
        input: this.#input,
        listener: this,
        model: this.#model,
        outputSchema: codexOutputSchema(this.#options),
        tools: this.#tools,
      })
      .catch((error) => {
        this.onError(error instanceof Error ? error : new Error(String(error)));
      });
  }

  onCompleted(input: {
    readonly error?: string;
    readonly status: "completed" | "failed" | "interrupted";
  }): void {
    if (this.#closed) return;
    if (input.status === "failed") {
      this.onError(new Error(input.error ?? "Codex app-server failed the model turn."));
      return;
    }
    this.#finishText();
    this.#finish({
      raw: input.status,
      unified: input.status === "completed" ? "stop" : "other",
    });
  }

  onError(error: Error): void {
    if (this.#closed) return;
    this.#finishText();
    this.#controller?.enqueue({ error, type: "error" });
    this.#finish({ raw: "error", unified: "error" });
  }

  onTextDelta(input: { readonly delta: string; readonly id: string }): void {
    if (this.#closed || input.delta.length === 0) return;
    if (!this.#openTextIds.has(input.id)) {
      this.#openTextIds.add(input.id);
      this.#controller?.enqueue({ id: input.id, type: "text-start" });
    }
    this.#controller?.enqueue({ delta: input.delta, id: input.id, type: "text-delta" });
  }

  onToolCall(input: CodexAppServerToolCall): void {
    if (this.#closed) return;
    if (input.namespace !== CODEX_DYNAMIC_TOOL_NAMESPACE || !this.#toolNames.has(input.tool)) {
      this.onError(
        new Error(
          `Codex app-server requested unavailable eve tool "${input.namespace === null ? input.tool : `${input.namespace}.${input.tool}`}".`,
        ),
      );
      return;
    }

    this.#finishText();
    this.#controller?.enqueue({
      input: stringifyCodexJson(input.arguments),
      toolCallId: input.callId,
      toolName: input.tool,
      type: "tool-call",
    });
    // A paused app-server request cannot survive eve's approval and restart boundary.
    // The next eve step replays its durable transcript into a fresh ephemeral session.
    this.#finish({ raw: "dynamic-tool-call", unified: "tool-calls" });
  }

  onUsage(usage: CodexAppServerUsage): void {
    this.#usage = {
      inputTokens: {
        cacheRead: usage.cachedInputTokens,
        cacheWrite: undefined,
        noCache: Math.max(0, usage.inputTokens - usage.cachedInputTokens),
        total: usage.inputTokens,
      },
      outputTokens: {
        reasoning: usage.reasoningOutputTokens,
        text: Math.max(0, usage.outputTokens - usage.reasoningOutputTokens),
        total: usage.outputTokens,
      },
    };
  }

  #cancel(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detachAbortListener();
    this.#session.dispose();
  }

  #finish(reason: {
    readonly raw: string;
    readonly unified: "error" | "other" | "stop" | "tool-calls";
  }): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detachAbortListener();
    this.#controller?.enqueue({
      finishReason: reason,
      type: "finish",
      usage: this.#usage,
    });
    this.#controller?.close();
    this.#session.dispose();
  }

  #finishText(): void {
    for (const id of this.#openTextIds) {
      this.#controller?.enqueue({ id, type: "text-end" });
    }
    this.#openTextIds.clear();
  }

  #detachAbortListener(): void {
    if (this.#abortHandler !== undefined && this.#options.abortSignal !== undefined) {
      this.#options.abortSignal.removeEventListener("abort", this.#abortHandler);
      this.#abortHandler = undefined;
    }
  }
}
