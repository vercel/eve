import { createOpenAI } from "#compiled/@ai-sdk/openai/index.js";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
} from "#compiled/@ai-sdk/provider/index.js";
import { createCodexFetch, type CodexTransportOptions } from "./transport.js";
import { isObject } from "#shared/guards.js";

const CODEX_LOCAL_AUTH_API_KEY = "codex-local-auth";

/** Configures the Codex model selected by the local Codex login. */
export interface CodexModelOptions {
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

  // The Codex backend rejects stored responses and server-side item ids, so
  // every call goes through normalizeCodexCallOptions before delegation.
  return {
    specificationVersion: openaiModel.specificationVersion,
    provider: openaiModel.provider,
    modelId: openaiModel.modelId,
    get supportedUrls() {
      return openaiModel.supportedUrls;
    },
    doGenerate: (callOptions: LanguageModelV4CallOptions) =>
      openaiModel.doGenerate(normalizeCodexCallOptions(callOptions)),
    doStream: (callOptions: LanguageModelV4CallOptions) =>
      openaiModel.doStream(normalizeCodexCallOptions(callOptions)),
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
    prompt: stripOpenAIItemIdsFromPrompt(prompt),
    providerOptions: {
      ...providerOptions,
      openai: {
        ...openaiOptions,
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

function stripOpenAIItemIdsFromPrompt(
  prompt: LanguageModelV4CallOptions["prompt"],
): LanguageModelV4CallOptions["prompt"] {
  return stripOpenAIItemIds(prompt, new WeakMap()) as LanguageModelV4CallOptions["prompt"];
}

/**
 * Copy-on-write: rebuilds only the spine of paths that actually carry an
 * OpenAI `itemId`, so untouched prompt content — the bulk of a long
 * conversation, tool outputs, file parts — is shared, not cloned, on every
 * model call.
 */
function stripOpenAIItemIds(value: unknown, memo: WeakMap<object, unknown>): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const memoized = memo.get(value);
  if (memoized !== undefined) {
    return memoized;
  }
  // In-progress marker: a cycle resolves to the original reference.
  memo.set(value, value);

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const stripped = stripOpenAIItemIds(item, memo);
      if (stripped !== item) changed = true;
      return stripped;
    });
    const result = changed ? next : value;
    memo.set(value, result);
    return result;
  }

  if (!isObject(value)) {
    return value;
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    let stripped = stripOpenAIItemIds(entryValue, memo);
    if (key === "providerOptions" || key === "providerMetadata") {
      stripped = withoutOpenAIItemId(stripped);
    }
    if (stripped !== entryValue) changed = true;
    next[key] = stripped;
  }
  const result = changed ? next : value;
  memo.set(value, result);
  return result;
}

function withoutOpenAIItemId(value: unknown): unknown {
  if (!isObject(value) || !isObject(value.openai) || !("itemId" in value.openai)) {
    return value;
  }
  const { itemId: _itemId, ...openaiOptions } = value.openai;
  return { ...value, openai: openaiOptions };
}
