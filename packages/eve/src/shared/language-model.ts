import type { LanguageModel } from "ai";

/**
 * Narrows a value to an AI SDK language model instance: an object carrying a
 * known specification version, provider and model ids, and callable
 * generate/stream entry points.
 */
export function isLanguageModelInstance(value: unknown): value is Exclude<LanguageModel, string> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("specificationVersion" in value)) {
    return false;
  }
  const specificationVersion = value.specificationVersion;
  if (
    specificationVersion !== "v2" &&
    specificationVersion !== "v3" &&
    specificationVersion !== "v4"
  ) {
    return false;
  }
  return (
    "provider" in value &&
    typeof value.provider === "string" &&
    "modelId" in value &&
    typeof value.modelId === "string" &&
    "doGenerate" in value &&
    typeof value.doGenerate === "function" &&
    "doStream" in value &&
    typeof value.doStream === "function"
  );
}

/**
 * Narrows a value to something eve can serve as a model at runtime: a
 * non-empty model id string or an AI SDK language model instance.
 */
export function isLanguageModelValue(value: unknown): value is LanguageModel {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return isLanguageModelInstance(value);
}
