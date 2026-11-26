import { defineExtension } from "eve/extension";
import type { Approval } from "eve/tools/approval";
import { z } from "zod";

import { isVideoModelLike } from "./lib/model.ts";
import type { VideoStorage } from "./lib/storage/types.ts";
import type { GenerateVideoToolInput, VideoModelLike } from "./lib/types.ts";

const str = () => z.string().min(1).optional();
const modelInputSchema = z.union([
  z.string().min(1),
  z.custom<VideoModelLike>(isVideoModelLike, "expected a v4 or v3 video model"),
]);

/** Adds video generation to an eve agent: a `generate` workflow tool backed by AI SDK and AI Gateway video models, provider-agnostic storage, and model-facing guidance. */
export default defineExtension({
  config: z.object({
    /** Default video model ID or v4/v3 model instance used when a tool call omits `model`. */
    model: modelInputSchema.optional(),
    /** Allowed model IDs or named aliases that callers may request at runtime. */
    models: z
      .union([z.array(z.string().min(1)).readonly(), z.record(z.string().min(1), modelInputSchema)])
      .optional(),
    /** Storage adapter for generated videos, or `false` to disable external storage. */
    storage: z
      .union([
        z.literal(false),
        z.custom<VideoStorage>(
          (v) => typeof v === "object" && v !== null && typeof Reflect.get(v, "put") === "function",
          "expected a VideoStorage adapter with a put() method",
        ),
      ])
      .optional(),
    /** Custom Vercel AI Gateway connection options for string video model IDs. */
    gateway: z
      .object({
        /** API key or access token sent to AI Gateway instead of the default credentials. */
        apiKey: str(),
        /** Custom AI Gateway base URL prefix. */
        baseURL: str(),
        /** Additional HTTP headers sent with AI Gateway requests. */
        headers: z.record(z.string(), z.string()).optional(),
      })
      .optional(),
    /** Default generation parameters applied when a tool call omits them. */
    defaults: z
      .object({
        /** Default aspect ratio such as `"16:9"`, `"9:16"`, or `"auto"`. */
        aspectRatio: str(),
        /** Default output resolution such as `"720p"`, `"1080p"`, or `"1280x720"`. */
        resolution: str(),
        /** Default target duration in seconds. */
        duration: z.number().positive().optional(),
        /** Default flag controlling whether generated videos include audio. */
        audio: z.boolean().optional(),
        /** Default output frame rate in frames per second. */
        fps: z.number().positive().optional(),
      })
      .optional(),
    /** Polling interval and timeout settings for asynchronous video generation jobs. */
    poll: z
      .object({
        /** Milliseconds to wait between status checks. */
        intervalMs: z.number().int().min(100).max(60_000).optional(),
        /** Maximum milliseconds to wait before timing out an asynchronous job. */
        timeoutMs: z.number().int().min(100).max(7_200_000).optional(),
      })
      .optional(),
    /** Controls webhook-driven completion (`"auto"` by default, or `"never"` to always poll). */
    webhook: z.enum(["auto", "never"]).optional(),
    /** Safety and cost limits enforced before submitting or downloading videos. */
    limits: z
      .object({
        /** Maximum allowed video duration in seconds. */
        maxDurationSeconds: z.number().positive().optional(),
        /** Maximum number of videos allowed per tool invocation. */
        maxVideosPerCall: z.number().int().min(1).optional(),
        /** Maximum size in bytes for input media files read from the sandbox. */
        maxInputBytes: z.number().int().positive().optional(),
        /** Maximum size in bytes for each downloaded generated video. */
        maxOutputBytes: z.number().int().positive().optional(),
      })
      .optional(),
    /** Optional approval policy or configuration gating video `generate` tool execution. */
    approval: z
      .custom<Approval<GenerateVideoToolInput>>(
        (v) =>
          typeof v === "function" ||
          (typeof v === "object" && v !== null && typeof Reflect.get(v, "request") === "function"),
        "expected an approval policy or configuration",
      )
      .optional(),
    /** Provider-specific options forwarded to the underlying video model call. */
    providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  }),
});
