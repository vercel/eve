import { createOpenAI } from "#compiled/@ai-sdk/openai/index.js";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
} from "#compiled/@ai-sdk/provider/index.js";
import { parseChatGptFastModelId } from "#shared/chatgpt-model.js";
import { createCodexFetch, type CodexTransportOptions } from "./transport.js";

const CODEX_LOCAL_AUTH_API_KEY = "codex-local-auth";

interface CodexModelOptions {
  readonly model: string;
}

export function createCodexSubscriptionModel(
  input: CodexModelOptions,
  options: CodexTransportOptions = {},
): LanguageModelV4 {
  const model = input.model.trim();
  if (model.length === 0) {
    throw new Error('Expected "model" to name a Codex model.');
  }
  const { slug, fast } = parseChatGptFastModelId(model);

  const openaiModel = createOpenAI({
    apiKey: CODEX_LOCAL_AUTH_API_KEY,
    fetch: createCodexFetch(options),
    name: "codex",
  }).responses(slug);

  return {
    specificationVersion: openaiModel.specificationVersion,
    provider: openaiModel.provider,
    modelId: model,
    get supportedUrls() {
      return openaiModel.supportedUrls;
    },
    doGenerate: (callOptions: LanguageModelV4CallOptions) =>
      openaiModel.doGenerate(normalizeCodexCallOptions(callOptions, fast)),
    doStream: (callOptions: LanguageModelV4CallOptions) =>
      openaiModel.doStream(normalizeCodexCallOptions(callOptions, fast)),
  };
}

function normalizeCodexCallOptions(
  options: LanguageModelV4CallOptions,
  fast: boolean,
): LanguageModelV4CallOptions {
  const providerOptions = options.providerOptions;
  const openaiOptions = providerOptions?.openai ?? {};

  const { instructions, prompt } = hoistSystemInstructions(options.prompt);

  const { maxOutputTokens: _maxOutputTokens, ...rest } = options;

  return {
    ...rest,
    prompt,
    providerOptions: {
      ...providerOptions,
      openai: {
        ...openaiOptions,
        ...((openaiOptions.serviceTier === "fast" ||
          (fast && openaiOptions.serviceTier === undefined)) && { serviceTier: "priority" }),
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
