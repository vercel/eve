import type { Approval } from "eve/tools/approval";

import type { VideoStorage, VideoStorageVisibility } from "./storage/types.ts";

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
  /** Optional hook present on models that support native terminal webhook notifications, such as Vercel AI Gateway models. */
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

/** A video model specified either as a gateway model ID or as a model instance. */
export type VideoModelInput = string | VideoModelLike;

/** Allowlist of gateway model IDs or named aliases mapping to video models. */
export type VideoModelCatalog = readonly string[] | Readonly<Record<string, VideoModelInput>>;

/** Custom Vercel AI Gateway connection options for string video model IDs. */
export interface VideoGatewayOptions {
  /** API key or access token sent to AI Gateway instead of the default credentials. */
  readonly apiKey?: string;
  /** Custom AI Gateway base URL prefix. */
  readonly baseURL?: string;
  /** Additional HTTP headers sent with AI Gateway requests. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Default generation parameters applied when a tool call omits them. */
export interface VideoDefaultsConfig {
  /** Default aspect ratio such as `"16:9"`, `"9:16"`, or `"auto"`. */
  readonly aspectRatio?: string;
  /** Default output resolution such as `"720p"`, `"1080p"`, or `"1280x720"`. */
  readonly resolution?: string;
  /** Default target duration in seconds. */
  readonly duration?: number;
  /** Default flag controlling whether generated videos include audio. */
  readonly audio?: boolean;
  /** Default output frame rate in frames per second. */
  readonly fps?: number;
}

/** Polling timing configuration for asynchronous video generation jobs. */
export interface VideoPollOptions {
  /** Milliseconds to wait between status checks. */
  readonly intervalMs?: number;
  /** Maximum milliseconds to wait before timing out an asynchronous job. */
  readonly timeoutMs?: number;
}

/** Safety and cost limits enforced before submitting or downloading videos. */
export interface VideoLimitsConfig {
  /** Maximum allowed video duration in seconds. */
  readonly maxDurationSeconds?: number;
  /** Maximum number of videos allowed per tool invocation. */
  readonly maxVideosPerCall?: number;
  /** Maximum size in bytes for input media files read from the sandbox. */
  readonly maxInputBytes?: number;
  /** Maximum size in bytes for each downloaded generated video. */
  readonly maxOutputBytes?: number;
}

/** Configuration options for the `@eve/video` extension. */
export interface VideoExtensionConfig {
  /** Default video model ID or model instance used when a call omits `model`. */
  readonly model?: VideoModelInput;
  /** Allowed model IDs or named aliases that callers may request at runtime. */
  readonly models?: VideoModelCatalog;
  /** Storage adapter for generated videos, or `false` to disable external storage. */
  readonly storage?: VideoStorage | false;
  /** Custom AI Gateway options used when resolving string model IDs. */
  readonly gateway?: VideoGatewayOptions;
  /** Default generation parameters applied when omitted from tool inputs. */
  readonly defaults?: VideoDefaultsConfig;
  /** Polling interval and timeout settings for asynchronous video models. */
  readonly poll?: VideoPollOptions;
  /**
   * Controls webhook-driven completion for asynchronous video jobs.
   * `"auto"` (default) uses `createWebhook()` when the model supports native terminal webhooks
   * and the host exposes a public `https://` webhook URL, falling back to durable `sleep()` polling
   * otherwise (such as in local `eve dev` or with direct provider models). `"never"` always polls.
   */
  readonly webhook?: "auto" | "never";
  /** Validation limits for duration, output count, and media byte sizes. */
  readonly limits?: VideoLimitsConfig;
  /** Optional approval policy gating the video `generate` tool execution. */
  readonly approval?: Approval<GenerateVideoToolInput>;
  /** Provider-specific options forwarded to the underlying video model call. */
  readonly providerOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Whether to return temporary provider URLs when neither storage nor a sandbox path is available. */
  readonly allowTemporaryProviderUrl?: boolean;
}

/** Input parameters accepted by the video `generate` tool. */
export interface GenerateVideoToolInput {
  /** Text description of the video to generate. */
  readonly prompt: string;
  /** Optional starting frame image as an HTTPS URL or sandbox file path. */
  readonly start?: string;
  /** Optional ending frame image as an HTTPS URL or sandbox file path. */
  readonly end?: string;
  /** Optional reference images or videos as HTTPS URLs or sandbox file paths. */
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
  /** Optional model ID or alias from the configured `models` catalog. */
  readonly model?: string;
  /** Optional sandbox path where the generated video should be written. */
  readonly path?: string;
}

/** Metadata describing a single generated video returned to the caller. */
export interface GeneratedVideoItem {
  /** Accessible URL for the stored or provider-hosted video, when available. */
  readonly url?: string;
  /** Direct download URL for the stored video, when provided by storage. */
  readonly downloadUrl?: string;
  /** Storage-specific key identifying the persisted video object. */
  readonly storageKey?: string;
  /** Storage path or pathname where the video was saved. */
  readonly storagePath?: string;
  /** Sandbox file path where the video was written, when requested. */
  readonly path?: string;
  /** IANA media type of the video, such as `"video/mp4"`. */
  readonly mediaType: string;
  /** Size of the video payload in bytes, or `0` when bytes were not downloaded locally (temporary provider URLs or provider-uploaded outputs). */
  readonly bytes: number;
  /** Visibility of the stored video when saved to external storage. */
  readonly visibility?: VideoStorageVisibility;
  /** ISO 8601 expiration timestamp for temporary URLs, when known. */
  readonly expiresAt?: string;
  /** Indicates that the returned URL is a temporary provider URL rather than durable storage. */
  readonly temporary?: boolean;
}

/** Progress update emitted while a video `generate` tool call is running. */
export type GenerateVideoToolProgress =
  | {
      /** Indicates that the generation request is being submitted. */
      readonly status: "starting";
      /** Resolved model ID handling the generation. */
      readonly model: string;
    }
  | {
      /** Indicates that an asynchronous video generation job is in progress. */
      readonly status: "generating";
      /** Resolved model ID handling the generation. */
      readonly model: string;
      /** Provider-assigned asynchronous job identifier, when available. */
      readonly jobId?: string;
      /** Whole seconds elapsed since the job started. */
      readonly elapsedSeconds: number;
      /** 1-based status polling attempt counter. */
      readonly attempt: number;
    }
  | {
      /** Indicates that generated videos are being downloaded and saved. */
      readonly status: "saving";
      /** Resolved model ID handling the generation. */
      readonly model: string;
      /** Provider-assigned asynchronous job identifier, when available. */
      readonly jobId?: string;
      /** Number of generated videos being persisted. */
      readonly videoCount: number;
    };

/** Final output returned by a completed video `generate` tool invocation. */
export interface GenerateVideoToolOutput {
  /** Terminal status indicating the generation succeeded. */
  readonly status: "completed";
  /** Resolved model ID that produced the videos. */
  readonly model: string;
  /** Provider-assigned asynchronous job identifier, when available. */
  readonly jobId?: string;
  /** Persisted or referenced videos produced by the generation call. */
  readonly videos: readonly GeneratedVideoItem[];
  /** Non-fatal warnings reported by the model or extension. */
  readonly warnings?: readonly string[];
}

/** Raw video output representation returned by a video model. */
export type VideoAssetData =
  | {
      /** Video delivered as a remote URL. */
      readonly type: "url";
      /** Remote URL pointing to the generated video. */
      readonly url: string;
      /** IANA media type of the video. */
      readonly mediaType: string;
    }
  | {
      /** Video delivered as a base64-encoded string. */
      readonly type: "base64";
      /** Base64-encoded video bytes. */
      readonly data: string;
      /** IANA media type of the video. */
      readonly mediaType: string;
    }
  | {
      /** Video delivered as in-memory binary bytes. */
      readonly type: "binary";
      /** Raw video bytes. */
      readonly data: Uint8Array;
      /** IANA media type of the video. */
      readonly mediaType: string;
    }
  | {
      /** Confirmation that the provider delivered the video directly to caller-managed storage. */
      readonly type: "uploaded";
      /** IANA media type of the uploaded video. */
      readonly mediaType: string;
    };

/** Opaque handle returned when starting an asynchronous video generation job. */
export interface VideoJobHandle {
  /** Resolved model ID used to start the job. */
  readonly modelId: string;
  /** JSON-serializable operation payload passed back when polling job status. */
  readonly operation: unknown;
  /** Provider-assigned job identifier, when reported in provider metadata. */
  readonly jobId?: string;
  /** Signing secret returned by AI Gateway when `webhookUrl` is set, for use with {@link verifyGatewayWebhookSignature}. */
  readonly webhookSigningSecret?: string;
  /** Storage keys of large local sandbox inputs staged during submission, when the caller should clean them up after completion. */
  readonly stagedInputKeys?: readonly string[];
  /** Non-fatal warnings emitted when starting the job. */
  readonly warnings: readonly string[];
}

/** Normalized status returned when polling an asynchronous video generation job. */
export type VideoJobStatus =
  | {
      /** Indicates that the job is still running. */
      readonly status: "pending";
      /** Non-fatal warnings emitted during the status check. */
      readonly warnings: readonly string[];
    }
  | {
      /** Indicates that the job finished and produced generated videos. */
      readonly status: "completed";
      /** Video assets returned by the provider. */
      readonly videos: readonly VideoAssetData[];
      /** Non-fatal warnings emitted by the completed job. */
      readonly warnings: readonly string[];
      /** ISO 8601 expiration timestamp for provider-hosted URLs, when reported. */
      readonly expiresAt?: string;
    }
  | {
      /** Indicates that the job terminated with an error. */
      readonly status: "error";
      /** Human-readable description of why the job failed. */
      readonly error: string;
    };

/** Input parameters for verifying a Vercel AI Gateway webhook signature. */
export interface VerifyGatewayWebhookInput {
  /** Value of the `x-ai-gateway-signature` HTTP header (`t=<seconds>,v1=<hex>`). */
  readonly header: string;
  /** Exact raw request payload bytes or UTF-8 string received by the webhook endpoint. */
  readonly rawBody: string | Uint8Array;
  /** Signing secret returned by AI Gateway when the asynchronous job started. */
  readonly secret: string;
  /** Maximum permitted clock skew or age in seconds. Defaults to `300`. */
  readonly maxAgeSeconds?: number;
  /** Current Unix timestamp in seconds, used for deterministic testing. */
  readonly nowSeconds?: number;
}
