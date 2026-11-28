import { createGateway, gateway } from "ai";

import type { VideoExtensionConfig, VideoModelLike } from "./types.ts";

export const DEFAULT_VIDEO_MODEL = "spacexai/grok-imagine-video";

const MODEL_GUIDANCE: readonly [RegExp, string][] = [
  [
    /(?:^|\/)grok-imagine-video-1\.5(?:$|-)/i,
    "Resolutions: 480p, 720p, or 1080p. Text-to-video and `start` image-to-video only (no native video edit or extend).",
  ],
  [
    /(?:^|\/)grok-imagine-video(?:$|-)/i,
    "Resolutions: 480p or 720p only (do not pass 1080p). Duration: 1–15s for text/image-to-video, or 1–10s when passing `references` or `extend: true` (extends a 2–15s clip by 2–10s). Supports `start`, image `references` (up to 7), in-place `video` edits (omit duration, aspectRatio, and resolution), and `extend: true`; does not support `end` frame.",
  ],
  [
    /(?:^|\/)seedance-2\.5-flash(?:$|-)/i,
    "Resolutions: 480p or 720p only (do not pass 1080p). Duration: 4–30s (omitted on in-place edits). Supports `start`/`end` frames, image/video/audio `references`, in-place `video` edits, and `extend: true`.",
  ],
  [
    /(?:^|\/)seedance-2\.5(?:$|-)/i,
    "Resolutions: 480p, 720p, or 1080p. Duration: 4–30s (omitted on in-place edits). Supports `start`/`end` frames, image/video/audio `references`, in-place `video` edits, and `extend: true`.",
  ],
  [
    /(?:^|\/)veo-3\.1.*lite/i,
    "Resolutions: 720p or 1080p. Aspect ratios: 16:9 or 9:16 only. Durations: 4, 6, or 8s only. Text-to-video only (no native video edit or extend).",
  ],
  [
    /(?:^|\/)veo-/i,
    "Resolutions: 720p, 1080p, or 4k. Aspect ratios: 16:9 or 9:16 only. Durations: 4, 6, or 8s only. Supports `start`/`end` frames and up to 3 JPG/PNG image `references` (do not combine `references` with `start`/`end`); no native in-place video edit.",
  ],
  [
    /(?:^|\/)flux-3-video/i,
    "Duration: 5–20s. Supports `start`/`end` frames and `extend: true`; do not combine `video` with `start`, `end`, or `references`.",
  ],
  [
    /(?:^|\/)wan-v3\.0/i,
    "Resolutions: 720p or 1080p. Supports `start`/`end` frames and image/video/audio `references`.",
  ],
];

export function formatConfiguredModelGuidance(config: VideoExtensionConfig): string {
  const modelId = describeDefaultModel(config);
  const lines = ["## Active video model", "", `Active model: \`${modelId}\`.`];
  const note = MODEL_GUIDANCE.find(([re]) => re.test(modelId))?.[1];
  if (note) lines.push(`- ${note}`);
  const defs: string[] = [];
  if (config.defaults?.duration !== undefined) defs.push(`duration=${config.defaults.duration}s`);
  if (config.defaults?.aspectRatio) defs.push(`aspectRatio=${config.defaults.aspectRatio}`);
  if (config.defaults?.resolution) defs.push(`resolution=${config.defaults.resolution}`);
  if (config.defaults?.audio !== undefined) defs.push(`audio=${config.defaults.audio}`);
  if (defs.length) lines.push(`- Configured defaults: ${defs.join(", ")}.`);
  const caps: string[] = [];
  if (config.limits?.maxDurationSeconds !== undefined)
    caps.push(`max duration ${config.limits.maxDurationSeconds}s`);
  if (config.limits?.maxVideosPerCall !== undefined)
    caps.push(`max ${config.limits.maxVideosPerCall} video(s) per call`);
  if (caps.length) lines.push(`- Configured limits: ${caps.join(", ")}.`);
  return lines.join("\n");
}

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

export function describeDefaultModel(config: VideoExtensionConfig): string {
  const input = config.model ?? DEFAULT_VIDEO_MODEL;
  return typeof input === "string"
    ? input.trim() || DEFAULT_VIDEO_MODEL
    : isVideoModelLike(input)
      ? input.modelId
      : DEFAULT_VIDEO_MODEL;
}

export function resolveConfiguredModel(config: VideoExtensionConfig) {
  return resolveModelInput(config.model ?? DEFAULT_VIDEO_MODEL, config.gateway);
}

export function resolveJobModel(config: VideoExtensionConfig, modelId: string) {
  const trimmed = modelId.trim();
  if (!trimmed) throw new Error("Video model must be a non-empty string.");
  const configured = config.model;
  if (configured !== undefined && idOf(configured) === trimmed)
    return resolveModelInput(configured, config.gateway);
  return resolveModelInput(trimmed, config.gateway);
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
