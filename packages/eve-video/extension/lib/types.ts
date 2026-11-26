import type extension from "../extension.ts";
import type { VideoStorageVisibility } from "./storage/types.ts";

/** Structural interface for an AI SDK v4 or v3 video generation model. */
export interface VideoModelLike {
  /** Video model specification version implemented by the provider. */
  readonly specificationVersion: "v4" | "v3";
  /** Provider identifier reported by the model. */
  readonly provider: string;
  /** Provider-specific model identifier. */
  readonly modelId: string;
  /** Maximum number of videos the model can generate in a single call. */
  readonly maxVideosPerCall?:
    | number
    | ((options: {
        readonly modelId: string;
      }) => PromiseLike<number | undefined> | number | undefined);
  /** Generates videos in a single call when supported by the provider. */
  doGenerate?(options: Readonly<Record<string, unknown>>): PromiseLike<unknown>;
  /** Optional hook present on models that support native terminal webhook notifications. */
  handleWebhookOption?(options: Readonly<Record<string, unknown>>): PromiseLike<unknown>;
  /** Starts an asynchronous video generation job and returns an operation handle. */
  doStart?(options: Readonly<Record<string, unknown>>): PromiseLike<unknown>;
  /** Checks the status of a previously started asynchronous video generation job. */
  doStatus?(options: {
    readonly operation: unknown;
    readonly abortSignal?: AbortSignal;
    readonly headers?: Readonly<Record<string, string | undefined>>;
  }): PromiseLike<unknown>;
}

/** Input parameters accepted by the video `generate` tool. */
export interface GenerateVideoToolInput {
  /** Text description of the video to generate, or the edit or continuation to apply to `video`. */
  readonly prompt: string;
  /** Optional existing video to edit or extend (an `https://` URL, a `storageKey`, or a sandbox path). Cannot be combined with `start` or `end`. */
  readonly video?: string;
  /** Continue from `video`'s last frame instead of editing it in place. Requires `video`. */
  readonly extend?: boolean;
  /** Optional starting frame image as an HTTPS URL or sandbox file path. */
  readonly start?: string;
  /** Optional ending frame image as an HTTPS URL or sandbox file path. */
  readonly end?: string;
  /** Optional reference images, videos, or audio clips as HTTPS URLs or sandbox file paths. */
  readonly references?: readonly string[];
  /** Requested video duration in seconds. */
  readonly duration?: number;
  /** Requested aspect ratio such as `"16:9"`, `"9:16"`, or `"auto"`. */
  readonly aspectRatio?: string;
  /** Requested output resolution such as `"720p"`, `"1080p"`, or `"1280x720"`. */
  readonly resolution?: string;
  /** Whether to generate audio alongside the video. */
  readonly audio?: boolean;
  /** Number of video variations to generate. */
  readonly n?: number;
  /** Target frame rate in frames per second. */
  readonly fps?: number;
  /** Deterministic seed for reproducible generation when supported by the model. */
  readonly seed?: number;
  /** Optional sandbox path where the generated video should be written. */
  readonly path?: string;
}

export interface GeneratedVideoItem {
  readonly url?: string;
  readonly downloadUrl?: string;
  readonly storageKey?: string;
  readonly storagePath?: string;
  readonly path?: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly visibility?: VideoStorageVisibility;
  readonly expiresAt?: string;
}

export interface GenerateVideoToolProgress {
  readonly status: "generating";
  readonly model: string;
  readonly jobId?: string;
  readonly elapsedSeconds: number;
  readonly attempt: number;
}

export interface GenerateVideoToolOutput {
  readonly status: "completed";
  readonly model: string;
  readonly jobId?: string;
  readonly videos: readonly GeneratedVideoItem[];
  readonly warnings?: readonly string[];
}

export type VideoExtensionConfig = typeof extension.config;

export interface VideoJobHandle {
  readonly modelId: string;
  readonly operation: unknown;
  readonly jobId?: string;
  readonly webhookSigningSecret?: string;
  readonly stagedInputKeys?: readonly string[];
  readonly warnings: readonly string[];
}
