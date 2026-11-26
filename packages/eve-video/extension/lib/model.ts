import { createGateway, gateway } from "ai";

import type {
  VideoExtensionConfig,
  VideoGatewayOptions,
  VideoModelCatalog,
  VideoModelInput,
  VideoModelLike,
} from "./types.ts";

/** Default AI Gateway video model ID used when no model or catalog is configured. */
export const DEFAULT_VIDEO_MODEL = "google/veo-3.1-fast-generate-001";

export function isVideoModelLike(value: unknown): value is VideoModelLike {
  if (typeof value !== "object" || value === null) return false;
  const specificationVersion = Reflect.get(value, "specificationVersion");
  if (specificationVersion !== "v4" && specificationVersion !== "v3") return false;
  const provider = Reflect.get(value, "provider");
  if (typeof provider !== "string" || provider.trim().length === 0) return false;
  const modelId = Reflect.get(value, "modelId");
  if (typeof modelId !== "string" || modelId.trim().length === 0) return false;
  return (
    typeof Reflect.get(value, "doGenerate") === "function" ||
    (typeof Reflect.get(value, "doStart") === "function" &&
      typeof Reflect.get(value, "doStatus") === "function")
  );
}

export function describeDefaultModel(config: VideoExtensionConfig, requested?: string): string {
  const trimmedRequested = requested?.trim();
  if (trimmedRequested) return trimmedRequested;
  const input = defaultModelInput(config);
  return typeof input === "string"
    ? input.trim() || DEFAULT_VIDEO_MODEL
    : isVideoModelLike(input)
      ? input.modelId
      : DEFAULT_VIDEO_MODEL;
}

export function resolveConfiguredModel(
  config: VideoExtensionConfig,
  requestedModel?: string,
): { readonly modelId: string; readonly model: VideoModelLike } {
  const defaultInput = defaultModelInput(config);
  if (requestedModel === undefined) {
    return resolveModelInput(defaultInput, config.gateway);
  }
  const requested = requestedModel.trim();
  if (requested.length === 0) {
    throw new Error("Video model must be a non-empty string.");
  }
  const defaultId = extractModelId(defaultInput);
  const catalog = config.models;
  if (catalog !== undefined) {
    const matched = isModelList(catalog)
      ? catalog.find((entry) => entry.trim() === requested)
      : Object.hasOwn(catalog, requested)
        ? catalog[requested]
        : Object.values(catalog).find((entry) => extractModelId(entry) === requested);
    if (matched !== undefined) return resolveModelInput(matched, config.gateway);
  }
  if (requested === defaultId) {
    return resolveModelInput(defaultInput, config.gateway);
  }
  if (catalog === undefined) {
    throw new Error(
      `Video model switching is not enabled because "models" is not configured. Omit "model" or use the active default model "${defaultId}".`,
    );
  }
  if (isModelList(catalog)) {
    const allowed = [...new Set(catalog.map((e) => e.trim()).filter(Boolean))];
    if (config.model !== undefined && !allowed.includes(defaultId)) allowed.push(defaultId);
    throw new Error(
      `Video model "${requested}" is not allowed. Allowed models: ${(allowed.length > 0 ? allowed : [defaultId]).join(", ")}.`,
    );
  }
  const aliases = Object.keys(catalog);
  throw new Error(
    aliases.length === 0
      ? `Video model "${requested}" is not allowed. Active default model: "${defaultId}".`
      : `Video model "${requested}" is not allowed. Allowed model aliases: ${aliases.join(", ")}.`,
  );
}

export function resolveJobModel(
  config: VideoExtensionConfig,
  modelId: string,
): { readonly modelId: string; readonly model: VideoModelLike } {
  const trimmed = modelId.trim();
  if (trimmed.length === 0) {
    throw new Error("Video model must be a non-empty string.");
  }
  if (config.model === undefined && config.models === undefined) {
    return resolveModelInput(trimmed, config.gateway);
  }
  return resolveConfiguredModel(config, trimmed);
}

function isModelList(catalog: VideoModelCatalog): catalog is readonly string[] {
  return Array.isArray(catalog);
}

function defaultModelInput(config: VideoExtensionConfig): VideoModelInput {
  if (config.model !== undefined) {
    if (
      typeof config.model === "string" &&
      config.models !== undefined &&
      !isModelList(config.models) &&
      Object.hasOwn(config.models, config.model)
    ) {
      return config.models[config.model];
    }
    return config.model;
  }
  if (config.models !== undefined && isModelList(config.models)) {
    const first = config.models.find((entry) => entry.trim().length > 0);
    if (first !== undefined) return first;
  } else if (config.models !== undefined) {
    const first = Object.values(config.models)[0];
    if (first !== undefined) return first;
  }
  return DEFAULT_VIDEO_MODEL;
}

function extractModelId(input: VideoModelInput): string {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length === 0) throw new Error("Video model ID must be a non-empty string.");
    return trimmed;
  }
  if (!isVideoModelLike(input)) {
    throw new Error(
      "Configured video model must be a non-empty model ID string or a v4/v3 VideoModelLike instance.",
    );
  }
  return input.modelId;
}

function resolveModelInput(
  input: VideoModelInput,
  gatewayOptions?: VideoGatewayOptions,
): { readonly modelId: string; readonly model: VideoModelLike } {
  const id = extractModelId(input);
  if (typeof input !== "string") {
    return { modelId: id, model: input };
  }
  const model = resolveStringVideoModel(id, gatewayOptions);
  return { modelId: model.modelId, model };
}

function resolveStringVideoModel(id: string, gatewayOptions?: VideoGatewayOptions): VideoModelLike {
  if (gatewayOptions !== undefined) {
    const gw = {
      ...(gatewayOptions.apiKey !== undefined && { apiKey: gatewayOptions.apiKey }),
      ...(gatewayOptions.baseURL !== undefined && { baseURL: gatewayOptions.baseURL }),
      ...(gatewayOptions.headers !== undefined && { headers: { ...gatewayOptions.headers } }),
    };
    if (Object.keys(gw).length > 0) {
      return createGateway(gw).videoModel(id);
    }
  }
  const defaultProvider = Reflect.get(globalThis, "AI_SDK_DEFAULT_PROVIDER");
  if (
    (typeof defaultProvider === "object" || typeof defaultProvider === "function") &&
    defaultProvider !== null
  ) {
    const videoModelFn = Reflect.get(defaultProvider, "videoModel");
    if (typeof videoModelFn === "function") {
      const resolved: unknown = Reflect.apply(videoModelFn, defaultProvider, [id]);
      if (!isVideoModelLike(resolved)) {
        throw new Error(
          `AI_SDK_DEFAULT_PROVIDER.videoModel("${id}") did not return a valid v4/v3 video model.`,
        );
      }
      return resolved;
    }
  }
  return gateway.videoModel(id);
}
