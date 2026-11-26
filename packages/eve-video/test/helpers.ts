import type { SandboxSession } from "eve/sandbox";
import type { WorkflowStepToolContext } from "eve/tools";
import type { ApprovalContext, ApprovalResponseContext } from "eve/tools/approval";

import type {
  GenerateVideoToolInput,
  VideoAssetData,
  VideoModelLike,
} from "../extension/lib/types.ts";

export const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

export const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
]);

export const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

export const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);

export const MP4_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
]);

export const MOV_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0x00, 0x00, 0x00, 0x00,
]);

export const WEBM_BYTES = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);

export const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00]);

export const WAV_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
]);

export const OGG_BYTES = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00]);

export const FLAC_BYTES = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22]);

export const M4A_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0x00, 0x00, 0x00, 0x00,
]);

export function createHttpError(
  statusCode: number,
  message: string,
): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

export function createLargePng(): Uint8Array {
  const bytes = new Uint8Array(185 * 1024);
  bytes.set(PNG_BYTES, 0);
  return bytes;
}

export interface RecordedStatusCall {
  readonly operation: unknown;
  readonly abortSignal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string | undefined>>;
}

export type AsyncStatusResponse =
  | {
      readonly status: "pending";
      readonly warnings?: readonly unknown[];
    }
  | {
      readonly status: "completed";
      readonly videos: readonly VideoAssetData[];
      readonly warnings?: readonly unknown[];
      readonly expiresAt?: string | number;
      readonly providerMetadata?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: "error";
      readonly error: string;
      readonly warnings?: readonly unknown[];
    };

export type AsyncStatusStep =
  | AsyncStatusResponse
  | ((
      call: RecordedStatusCall,
      index: number,
    ) => AsyncStatusResponse | Promise<AsyncStatusResponse>);

export interface CreateAsyncVideoModelOptions {
  readonly modelId?: string;
  readonly provider?: string;
  readonly specificationVersion?: "v4" | "v3";
  readonly maxVideosPerCall?: VideoModelLike["maxVideosPerCall"];
  readonly handleWebhookOption?: boolean;
  readonly jobId?: string;
  readonly webhookSigningSecret?: string;
  readonly operation?: unknown;
  readonly startWarnings?: readonly unknown[];
  readonly statuses?: readonly AsyncStatusStep[];
  readonly repeatLastStatus?: boolean;
  readonly onStart?: (options: Readonly<Record<string, unknown>>) => void | Promise<void>;
}

export interface FakeAsyncVideoModelHandle {
  readonly model: VideoModelLike;
  readonly startCalls: Readonly<Record<string, unknown>>[];
  readonly statusCalls: RecordedStatusCall[];
}

export function createAsyncVideoModel(
  options: CreateAsyncVideoModelOptions = {},
): FakeAsyncVideoModelHandle {
  const modelId = options.modelId ?? "test/video-async";
  const provider = options.provider ?? "test-provider";
  const specificationVersion = options.specificationVersion ?? "v4";
  const operation = options.operation ?? { id: "op_1", token: "tok_1" };
  const startWarnings = options.startWarnings ?? [];
  const statuses: readonly AsyncStatusStep[] = options.statuses ?? [
    {
      status: "completed",
      videos: [{ type: "binary", data: MP4_BYTES, mediaType: "video/mp4" }],
    },
  ];
  const repeatLastStatus = options.repeatLastStatus ?? true;

  const startCalls: Readonly<Record<string, unknown>>[] = [];
  const statusCalls: RecordedStatusCall[] = [];

  const model: VideoModelLike = {
    specificationVersion,
    provider,
    modelId,
    maxVideosPerCall: options.maxVideosPerCall,
    ...(options.handleWebhookOption === true && {
      async handleWebhookOption() {
        return undefined;
      },
    }),
    async doStart(callOptions) {
      startCalls.push(callOptions);
      if (options.onStart !== undefined) {
        await options.onStart(callOptions);
      }
      const asyncJob: { jobId?: string; webhookSigningSecret?: string } = {};
      if (options.jobId !== undefined) {
        asyncJob.jobId = options.jobId;
      }
      if (options.webhookSigningSecret !== undefined) {
        asyncJob.webhookSigningSecret = options.webhookSigningSecret;
      }
      const providerMetadata =
        Object.keys(asyncJob).length > 0 ? { gateway: { asyncJob } } : undefined;
      const result: {
        operation: unknown;
        warnings: readonly unknown[];
        providerMetadata?: Readonly<Record<string, unknown>>;
        response: {
          timestamp: Date;
          modelId: string;
          headers: Record<string, string>;
        };
      } = {
        operation,
        warnings: [...startWarnings],
        response: {
          timestamp: new Date(),
          modelId,
          headers: {},
        },
      };
      if (providerMetadata !== undefined) {
        result.providerMetadata = providerMetadata;
      }
      return result;
    },
    async doStatus(callOptions) {
      const index = statusCalls.length;
      statusCalls.push(callOptions);
      const stepIndex =
        index < statuses.length
          ? index
          : repeatLastStatus && statuses.length > 0
            ? statuses.length - 1
            : -1;
      if (stepIndex < 0) {
        throw new Error(`Unexpected doStatus call #${index + 1} for ${modelId}.`);
      }
      const step = statuses[stepIndex];
      const resolved = typeof step === "function" ? await step(callOptions, index) : step;
      if (resolved.status === "completed") {
        const providerMetadata =
          resolved.providerMetadata ??
          (resolved.expiresAt !== undefined
            ? { gateway: { asyncJob: { result: { expiresAt: resolved.expiresAt } } } }
            : undefined);
        const completed: {
          status: "completed";
          videos: readonly VideoAssetData[];
          warnings: readonly unknown[];
          providerMetadata?: Readonly<Record<string, unknown>>;
          response: {
            timestamp: Date;
            modelId: string;
            headers: Record<string, string>;
          };
        } = {
          status: "completed",
          videos: resolved.videos,
          warnings: [...(resolved.warnings ?? [])],
          response: {
            timestamp: new Date(),
            modelId,
            headers: {},
          },
        };
        if (providerMetadata !== undefined) {
          completed.providerMetadata = providerMetadata;
        }
        return completed;
      }
      if (resolved.status === "error") {
        return {
          status: "error",
          error: resolved.error,
          warnings: [...(resolved.warnings ?? [])],
        };
      }
      return {
        status: "pending",
        warnings: [...(resolved.warnings ?? [])],
      };
    },
  };

  return { model, startCalls, statusCalls };
}

export interface CreateSyncVideoModelOptions {
  readonly modelId?: string;
  readonly provider?: string;
  readonly specificationVersion?: "v4" | "v3";
  readonly maxVideosPerCall?: VideoModelLike["maxVideosPerCall"];
  readonly videos?: readonly VideoAssetData[];
  readonly warnings?: readonly unknown[];
  readonly expiresAt?: string | number;
  readonly providerMetadata?: Readonly<Record<string, unknown>>;
  readonly onGenerate?: (options: Readonly<Record<string, unknown>>) => void | Promise<void>;
}

export interface FakeSyncVideoModelHandle {
  readonly model: VideoModelLike;
  readonly generateCalls: Readonly<Record<string, unknown>>[];
}

export function createSyncVideoModel(
  options: CreateSyncVideoModelOptions = {},
): FakeSyncVideoModelHandle {
  const modelId = options.modelId ?? "test/video-sync";
  const provider = options.provider ?? "test-provider";
  const specificationVersion = options.specificationVersion ?? "v4";
  const videos: readonly VideoAssetData[] = options.videos ?? [
    { type: "binary", data: MP4_BYTES, mediaType: "video/mp4" },
  ];
  const warnings = options.warnings ?? [];
  const generateCalls: Readonly<Record<string, unknown>>[] = [];

  const model: VideoModelLike = {
    specificationVersion,
    provider,
    modelId,
    maxVideosPerCall: options.maxVideosPerCall,
    async doGenerate(callOptions) {
      generateCalls.push(callOptions);
      if (options.onGenerate !== undefined) {
        await options.onGenerate(callOptions);
      }
      const providerMetadata =
        options.providerMetadata ??
        (options.expiresAt !== undefined
          ? { gateway: { asyncJob: { result: { expiresAt: options.expiresAt } } } }
          : undefined);
      const response: {
        videos: readonly VideoAssetData[];
        warnings: readonly unknown[];
        providerMetadata?: Readonly<Record<string, unknown>>;
        response: {
          timestamp: Date;
          modelId: string;
          headers: Record<string, string>;
        };
      } = {
        videos,
        warnings: [...warnings],
        response: {
          timestamp: new Date(),
          modelId,
          headers: {},
        },
      };
      if (providerMetadata !== undefined) {
        response.providerMetadata = providerMetadata;
      }
      return response;
    },
  };

  return { model, generateCalls };
}

export interface FakeSandbox extends Pick<SandboxSession, "readBinaryFile" | "writeBinaryFile"> {
  readonly files: Map<string, Uint8Array>;
}

export function createFakeSandbox(
  initialFiles?: Readonly<Record<string, Uint8Array>> | Iterable<readonly [string, Uint8Array]>,
): FakeSandbox {
  const files = new Map<string, Uint8Array>();
  if (initialFiles !== undefined) {
    const entries =
      Symbol.iterator in initialFiles
        ? initialFiles
        : Object.entries(initialFiles as Readonly<Record<string, Uint8Array>>);
    for (const [path, bytes] of entries) {
      files.set(path, Uint8Array.from(bytes));
    }
  }

  return {
    files,
    async readBinaryFile({ path, signal }) {
      signal?.throwIfAborted();
      const stored = files.get(path);
      return stored === undefined ? null : Uint8Array.from(stored);
    },
    async writeBinaryFile({ path, content, signal }) {
      signal?.throwIfAborted();
      files.set(path, Uint8Array.from(content));
    },
  };
}

export interface FakeStepContextOptions {
  readonly sessionId?: string;
  readonly callId?: string;
  readonly toolName?: string;
  readonly signal?: AbortSignal;
  readonly sandbox?: FakeSandbox;
  readonly getSandbox?: () => Promise<Pick<SandboxSession, "readBinaryFile" | "writeBinaryFile">>;
}

export function createFakeStepContext(
  options: FakeStepContextOptions = {},
): WorkflowStepToolContext {
  const abortSignal = options.signal ?? new AbortController().signal;
  const getSandbox =
    options.getSandbox ??
    (options.sandbox !== undefined
      ? async () => options.sandbox as FakeSandbox
      : async () => {
          throw new Error("Sandbox is not configured in this test context.");
        });
  return {
    abortSignal,
    callId: options.callId ?? "call-1",
    toolName: options.toolName ?? "video__generate",
    session: {
      id: options.sessionId ?? "session-1",
    },
    getSandbox,
  } as never;
}

export interface FakePrincipal {
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalType: string;
  readonly principalId: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export function createFakePrincipal(
  principalId: string,
  options: {
    readonly authenticator?: string;
    readonly issuer?: string;
    readonly principalType?: string;
  } = {},
): FakePrincipal {
  const principal: {
    authenticator: string;
    issuer?: string;
    principalType: string;
    principalId: string;
    attributes: Readonly<Record<string, unknown>>;
  } = {
    authenticator: options.authenticator ?? "test-auth",
    principalType: options.principalType ?? "user",
    principalId,
    attributes: {},
  };
  if (options.issuer !== undefined) {
    principal.issuer = options.issuer;
  }
  return principal;
}

export function createFakeApprovalContext(
  input: GenerateVideoToolInput,
  options: {
    readonly callId?: string;
    readonly toolName?: string;
    readonly sessionId?: string;
    readonly principal?: FakePrincipal | null;
  } = {},
): ApprovalContext<GenerateVideoToolInput> {
  const principal =
    options.principal === undefined ? createFakePrincipal("user-1") : options.principal;
  const ctx = {
    abortSignal: new AbortController().signal,
    callId: options.callId ?? "call-1",
    toolName: options.toolName ?? "video__generate",
    toolInput: input,
    session: {
      id: options.sessionId ?? "session-1",
      auth: {
        current: principal,
        initiator: principal,
      },
      turn: {
        id: "turn-1",
        index: 1,
      },
    },
  };
  return ctx as never;
}

export function createFakeApprovalResponseContext(
  input: GenerateVideoToolInput,
  options: {
    readonly requester: FakePrincipal | null;
    readonly responder: FakePrincipal;
    readonly decision?: "approve" | "deny";
    readonly callId?: string;
    readonly toolName?: string;
  },
): ApprovalResponseContext<GenerateVideoToolInput> {
  const ctx = {
    auth: {
      async getToken() {
        throw new Error("Unexpected getToken call.");
      },
      requireAuth(): never {
        throw new Error("Unexpected requireAuth call.");
      },
    },
    request: {
      callId: options.callId ?? "call-1",
      interactionId: "interaction-1",
      principal: options.requester,
      toolInput: input,
      toolName: options.toolName ?? "video__generate",
    },
    response: {
      decision: options.decision ?? "approve",
      principal: options.responder,
    },
    session: {
      id: "session-1",
      initiator: options.requester,
      turn: {
        id: "turn-1",
        index: 1,
      },
    },
  };
  return ctx as never;
}
