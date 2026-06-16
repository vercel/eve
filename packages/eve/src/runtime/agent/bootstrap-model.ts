import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import {
  BOOTSTRAP_RUNTIME_MODEL_ID,
  type RuntimeModelReference,
} from "#runtime/agent/bootstrap.js";
import {
  type BootstrapGenerateResult,
  type BootstrapPrompt,
  createBootstrapGenerateResult,
  createBootstrapStreamResult,
  estimateTokenCount,
  getLastUserPromptText,
  getPromptText,
} from "#runtime/agent/bootstrap-model-utils.js";

const BOOTSTRAP_MODEL_PROVIDER = "eve-bootstrap";
const bootstrapRuntimeModels = new Map<string, LanguageModel>();

/**
 * Resolves the framework-owned bootstrap model into a deterministic local
 * language model.
 */
export function resolveBootstrapRuntimeModel(
  reference: RuntimeModelReference,
): LanguageModel | null {
  if (reference.id !== BOOTSTRAP_RUNTIME_MODEL_ID) {
    return null;
  }

  const existingModel = bootstrapRuntimeModels.get(reference.id);

  if (existingModel !== undefined) {
    return existingModel;
  }

  const model = new MockLanguageModelV3({
    doGenerate: async (options) => createBootstrapModelResult(options.prompt, reference.id),
    doStream: async (options) =>
      createBootstrapStreamResult(createBootstrapModelResult(options.prompt, reference.id)),
    modelId: reference.id,
    provider: BOOTSTRAP_MODEL_PROVIDER,
  });

  bootstrapRuntimeModels.set(reference.id, model);

  return model;
}

function createBootstrapModelResult(
  prompt: BootstrapPrompt,
  modelId: string,
): BootstrapGenerateResult {
  const lastUserMessage = getLastUserPromptText(prompt) ?? "Hello from eve";
  const text = `Bootstrap reply: ${lastUserMessage}`;

  return createBootstrapGenerateResult({
    inputTokens: estimateTokenCount(getPromptText(prompt)),
    modelId,
    outputTokens: estimateTokenCount(text),
    text,
  });
}
