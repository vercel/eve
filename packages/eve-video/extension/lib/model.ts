import { createGateway, gateway } from "ai";

import type { VideoExtensionConfig, VideoModelLike } from "./types.ts";

export const DEFAULT_VIDEO_MODEL = "google/veo-3.1-fast-generate-001";

const isList = (v: unknown): v is readonly string[] => Array.isArray(v);
const idOf = (x: string | VideoModelLike) => {
  if (typeof x === "string") {
    if (!x.trim()) throw new Error("Video model ID must be a non-empty string.");
    return x.trim();
  }
  if (!isVideoModelLike(x))
    throw new Error("Configured video model must be a model ID or v4/v3 VideoModel.");
  return x.modelId;
};

export function isVideoModelLike(v: unknown): v is VideoModelLike {
  if (typeof v !== "object" || v === null) return false;
  const [spec, prov, id] = [
    Reflect.get(v, "specificationVersion"),
    Reflect.get(v, "provider"),
    Reflect.get(v, "modelId"),
  ];
  if (
    (spec !== "v4" && spec !== "v3") ||
    typeof prov !== "string" ||
    !prov.trim() ||
    typeof id !== "string" ||
    !id.trim()
  )
    return false;
  return (
    typeof Reflect.get(v, "doGenerate") === "function" ||
    (typeof Reflect.get(v, "doStart") === "function" &&
      typeof Reflect.get(v, "doStatus") === "function")
  );
}

export function describeDefaultModel(config: VideoExtensionConfig, requested?: string): string {
  if (requested?.trim()) return requested.trim();
  const input = defaultModelInput(config);
  return typeof input === "string"
    ? input.trim() || DEFAULT_VIDEO_MODEL
    : isVideoModelLike(input)
      ? input.modelId
      : DEFAULT_VIDEO_MODEL;
}

export function resolveConfiguredModel(config: VideoExtensionConfig, requestedModel?: string) {
  const defaultInput = defaultModelInput(config);
  if (requestedModel === undefined) return resolveModelInput(defaultInput, config.gateway);
  const requested = requestedModel.trim();
  if (!requested) throw new Error("Video model must be a non-empty string.");
  const defaultId = idOf(defaultInput);
  const catalog = config.models;
  if (catalog !== undefined) {
    const matched = isList(catalog)
      ? catalog.find((e) => e.trim() === requested)
      : Object.hasOwn(catalog, requested)
        ? catalog[requested]
        : Object.values(catalog).find((e) => idOf(e) === requested);
    if (matched !== undefined) return resolveModelInput(matched, config.gateway);
  }
  if (requested === defaultId) return resolveModelInput(defaultInput, config.gateway);
  if (catalog === undefined)
    throw new Error(`Model switching requires "models" config; use "${defaultId}".`);
  const allowed = isList(catalog)
    ? [
        ...new Set([
          ...catalog.map((e) => e.trim()).filter(Boolean),
          ...(config.model !== undefined ? [defaultId] : []),
        ]),
      ]
    : Object.keys(catalog);
  throw new Error(
    `Video model "${requested}" is not allowed. ${allowed.length ? `Allowed: ${allowed.join(", ")}` : `Default: "${defaultId}"`}.`,
  );
}

export function resolveJobModel(config: VideoExtensionConfig, modelId: string) {
  const trimmed = modelId.trim();
  if (!trimmed) throw new Error("Video model must be a non-empty string.");
  return config.model === undefined && config.models === undefined
    ? resolveModelInput(trimmed, config.gateway)
    : resolveConfiguredModel(config, trimmed);
}

function defaultModelInput(config: VideoExtensionConfig): string | VideoModelLike {
  if (config.model !== undefined) {
    return typeof config.model === "string" &&
      config.models &&
      !isList(config.models) &&
      Object.hasOwn(config.models, config.model)
      ? config.models[config.model]
      : config.model;
  }
  return (
    (config.models
      ? isList(config.models)
        ? config.models.find((e) => e.trim())
        : Object.values(config.models)[0]
      : undefined) ?? DEFAULT_VIDEO_MODEL
  );
}

function resolveModelInput(
  input: string | VideoModelLike,
  gwOpts?: VideoExtensionConfig["gateway"],
): { readonly modelId: string; readonly model: VideoModelLike } {
  const id = idOf(input);
  if (typeof input !== "string") return { modelId: id, model: input };
  if (gwOpts) {
    const gw = {
      ...(gwOpts.apiKey !== undefined && { apiKey: gwOpts.apiKey }),
      ...(gwOpts.baseURL !== undefined && { baseURL: gwOpts.baseURL }),
      ...(gwOpts.headers !== undefined && { headers: { ...gwOpts.headers } }),
    };
    if (Object.keys(gw).length) {
      const m = createGateway(gw).videoModel(id);
      return { modelId: m.modelId, model: m };
    }
  }
  const provider = Reflect.get(globalThis, "AI_SDK_DEFAULT_PROVIDER");
  const fn =
    (typeof provider === "object" || typeof provider === "function") && provider !== null
      ? Reflect.get(provider, "videoModel")
      : undefined;
  if (typeof fn === "function") {
    const resolved: unknown = Reflect.apply(fn, provider, [id]);
    if (!isVideoModelLike(resolved))
      throw new Error(
        `AI_SDK_DEFAULT_PROVIDER.videoModel("${id}") returned an invalid video model.`,
      );
    return { modelId: resolved.modelId, model: resolved };
  }
  const m = gateway.videoModel(id);
  return { modelId: m.modelId, model: m };
}
