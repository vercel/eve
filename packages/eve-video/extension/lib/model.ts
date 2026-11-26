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
  if (requested !== undefined && requested.trim().length > 0) return requested.trim();
  const input = defaultModelInput(config);
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : DEFAULT_VIDEO_MODEL;
  }
  return isVideoModelLike(input) ? input.modelId : DEFAULT_VIDEO_MODEL;
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
  if (config.models !== undefined && isModelList(config.models)) {
    const matched = config.models.find((entry) => entry.trim() === requested);
    if (matched !== undefined) return resolveModelInput(matched, config.gateway);
    if (requested === defaultId) return resolveModelInput(defaultInput, config.gateway);
    const allowed = [...new Set(config.models.map((e) => e.trim()).filter(Boolean))];
    if (config.model !== undefined && !allowed.includes(defaultId)) allowed.push(defaultId);
    throw new Error(
      `Video model "${requested}" is not allowed. Allowed models: ${(allowed.length > 0 ? allowed : [defaultId]).join(", ")}.`,
    );
  }
  if (config.models !== undefined) {
    if (Object.hasOwn(config.models, requested)) {
      return resolveModelInput(config.models[requested], config.gateway);
    }
    const matchedById = Object.values(config.models).find(
      (entry) => extractModelId(entry) === requested,
    );
    if (matchedById !== undefined) return resolveModelInput(matchedById, config.gateway);
    if (requested === defaultId) return resolveModelInput(defaultInput, config.gateway);
    const aliases = Object.keys(config.models);
    if (aliases.length === 0) {
      throw new Error(
        `Video model "${requested}" is not allowed. Active default model: "${defaultId}".`,
      );
    }
    throw new Error(
      `Video model "${requested}" is not allowed. Allowed model aliases: ${aliases.join(", ")}.`,
    );
  }
  if (requested === defaultId) {
    return resolveModelInput(defaultInput, config.gateway);
  }
  throw new Error(
    `Video model switching is not enabled because "models" is not configured. Omit "model" or use the active default model "${defaultId}".`,
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
  if (typeof input !== "string") {
    if (!isVideoModelLike(input)) {
      throw new Error(
        "Configured video model must be a non-empty model ID string or a v4/v3 VideoModelLike instance.",
      );
    }
    return { modelId: input.modelId, model: input };
  }
  const id = input.trim();
  if (id.length === 0) throw new Error("Video model ID must be a non-empty string.");
  const model = resolveStringVideoModel(id, gatewayOptions);
  return { modelId: model.modelId, model };
}

function resolveStringVideoModel(id: string, gatewayOptions?: VideoGatewayOptions): VideoModelLike {
  if (
    gatewayOptions !== undefined &&
    (gatewayOptions.apiKey !== undefined ||
      gatewayOptions.baseURL !== undefined ||
      gatewayOptions.headers !== undefined)
  ) {
    return createGateway({
      ...(gatewayOptions.apiKey !== undefined && { apiKey: gatewayOptions.apiKey }),
      ...(gatewayOptions.baseURL !== undefined && { baseURL: gatewayOptions.baseURL }),
      ...(gatewayOptions.headers !== undefined && { headers: { ...gatewayOptions.headers } }),
    }).videoModel(id);
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
