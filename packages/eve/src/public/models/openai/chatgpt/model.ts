import { createOpenAI } from "#compiled/@ai-sdk/openai/index.js";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from "#compiled/@ai-sdk/provider/index.js";
import { createCodexFetch, type CodexTransportOptions } from "./transport.js";

const CODEX_LOCAL_AUTH_API_KEY = "codex-local-auth";

/** Configures the Codex model selected by the local ChatGPT login. */
interface CodexModelOptions {
  /** OpenAI model ID passed to the Codex Responses endpoint, for example `gpt-5.6-sol`. */
  readonly model: string;
}

// Test seam for the direct Codex transport boundary.
export function createCodexSubscriptionModel(
  input: CodexModelOptions,
  options: CodexTransportOptions = {},
): LanguageModelV4 {
  const model = input.model.trim();
  if (model.length === 0) {
    throw new Error('Expected "model" to name a Codex model.');
  }

  const openaiModel = createOpenAI({
    apiKey: CODEX_LOCAL_AUTH_API_KEY,
    fetch: createCodexFetch(options),
    name: "codex",
  }).responses(model);

  // Keep item IDs until the provider has grouped streamed reasoning summaries.
  // The transport removes them from the stateless request sent to Codex.
  return {
    specificationVersion: openaiModel.specificationVersion,
    provider: openaiModel.provider,
    modelId: openaiModel.modelId,
    get supportedUrls() {
      return openaiModel.supportedUrls;
    },
    // The Codex backend rejects non-streaming requests (`Stream must be set to true`), so a
    // generate call streams and collects the result.
    doGenerate: async (callOptions: LanguageModelV4CallOptions) =>
      collectStreamResult(await openaiModel.doStream(normalizeCodexCallOptions(callOptions))),
    doStream: (callOptions: LanguageModelV4CallOptions) =>
      openaiModel.doStream(normalizeCodexCallOptions(callOptions)),
  };
}

async function collectStreamResult(
  result: LanguageModelV4StreamResult,
): Promise<LanguageModelV4GenerateResult> {
  const content: LanguageModelV4Content[] = [];
  const openParts = new Map<string, Extract<LanguageModelV4Content, { text: string }>>();
  let warnings: LanguageModelV4GenerateResult["warnings"] = [];
  let responseMetadata: LanguageModelV4GenerateResult["response"] = {};
  let finish:
    | Pick<LanguageModelV4GenerateResult, "finishReason" | "providerMetadata" | "usage">
    | undefined;

  for await (const part of result.stream) {
    switch (part.type) {
      case "text-start":
      case "reasoning-start": {
        const item: Extract<LanguageModelV4Content, { text: string }> = {
          type: part.type === "text-start" ? "text" : "reasoning",
          text: "",
          providerMetadata: part.providerMetadata,
        };
        content.push(item);
        openParts.set(`${item.type}:${part.id}`, item);
        break;
      }
      case "text-delta":
      case "reasoning-delta": {
        const kind = part.type === "text-delta" ? "text" : "reasoning";
        const item = openParts.get(`${kind}:${part.id}`);
        if (item !== undefined) item.text += part.delta;
        break;
      }
      case "text-end":
      case "reasoning-end": {
        const kind = part.type === "text-end" ? "text" : "reasoning";
        const item = openParts.get(`${kind}:${part.id}`);
        if (item !== undefined && part.providerMetadata !== undefined) {
          item.providerMetadata = part.providerMetadata;
        }
        openParts.delete(`${kind}:${part.id}`);
        break;
      }
      // The completed `tool-call` part carries the full input.
      case "tool-input-start":
      case "tool-input-delta":
      case "tool-input-end":
      case "raw":
        break;
      case "stream-start":
        warnings = part.warnings;
        break;
      case "response-metadata": {
        const { type: _type, ...metadata } = part;
        responseMetadata = { ...responseMetadata, ...metadata };
        break;
      }
      case "finish":
        finish = {
          finishReason: part.finishReason,
          providerMetadata: part.providerMetadata,
          usage: part.usage,
        };
        break;
      case "error":
        throw part.error;
      default:
        content.push(part);
    }
  }

  if (finish === undefined) {
    throw new Error("The Codex response stream ended before the response finished.");
  }
  return {
    ...finish,
    content,
    request: result.request,
    response: { ...responseMetadata, headers: result.response?.headers },
    warnings,
  };
}

function normalizeCodexCallOptions(
  options: LanguageModelV4CallOptions,
): LanguageModelV4CallOptions {
  const providerOptions = options.providerOptions;
  const openaiOptions = providerOptions?.openai ?? {};

  // The Codex backend requires system instructions in the top-level
  // `instructions` field and rejects a `developer`/`system` role inside the
  // `input` array (the shape the AI SDK produces by default). Hoist the system
  // messages out of the prompt and into `instructions` before delegation.
  const { instructions, prompt } = hoistSystemInstructions(options.prompt);

  // The Codex backend rejects `max_output_tokens` with
  // `400 Unsupported parameter`, so drop it before delegation.
  const { maxOutputTokens: _maxOutputTokens, ...rest } = options;

  return {
    ...rest,
    prompt,
    providerOptions: {
      ...providerOptions,
      openai: {
        ...openaiOptions,
        // OpenAI documents `fast` as an alias of `priority`, but the Codex
        // backend rejects `fast`. Codex itself sends `priority` for Fast mode.
        ...(openaiOptions.serviceTier === "fast" && { serviceTier: "priority" }),
        ...(instructions !== undefined && { instructions }),
        store: false,
      },
    },
  };
}

function hoistSystemInstructions(prompt: LanguageModelV4CallOptions["prompt"]): {
  readonly instructions: string | undefined;
  readonly prompt: LanguageModelV4CallOptions["prompt"];
} {
  const systemContent = prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content);
  if (systemContent.length === 0) {
    return { instructions: undefined, prompt };
  }
  return {
    instructions: systemContent.join("\n\n"),
    prompt: prompt.filter((message) => message.role !== "system"),
  };
}
