import type { SandboxSession } from "eve/sandbox";
import type { WorkflowStepToolContext } from "eve/tools";
import type { ApprovalContext } from "eve/tools/approval";

import type { GenerateVideoToolInput, VideoModelLike } from "../extension/lib/types.ts";

const hex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const pad = (h: Uint8Array) => {
  const b = new Uint8Array(185 * 1024);
  b.set(h);
  return b;
};

export const PNG_BYTES = hex("89504e470d0a1a0a0000000d");
export const JPEG_BYTES = hex("ffd8ffe000104a464946");
export const WEBP_BYTES = hex("524946460400000057454250");
export const GIF_BYTES = hex("4749463839610100");
export const MP4_BYTES = hex("000000186674797069736f6d00000200");
export const MOV_BYTES = hex("00000014667479707174202000000000");
export const WEBM_BYTES = hex("1a45dfa39f428681");
export const MP3_BYTES = hex("4944330300000000");
export const WAV_BYTES = hex("524946460400000057415645");
export const createLargePng = () => pad(PNG_BYTES);
export const createLargeMp4 = () => pad(MP4_BYTES);
export const createHttpError = (statusCode: number, msg: string) =>
  Object.assign(new Error(msg), { statusCode });

type Rec = Readonly<Record<string, unknown>>;
type Asset =
  | { type: "binary"; data: Uint8Array; mediaType: string }
  | { type: "url"; url: string; mediaType: string };
type StatusRes =
  | { status: "pending"; warnings?: readonly unknown[] }
  | { status: "completed"; videos: readonly Asset[]; warnings?: readonly unknown[] }
  | { status: "error"; error: string; warnings?: readonly unknown[] };
type StatusStep = StatusRes | ((call: Rec, idx: number) => Promise<StatusRes>);
const mkResp = (modelId: string) => ({ timestamp: new Date(), modelId, headers: {} });
const DEF_VID: readonly Asset[] = [{ type: "binary", data: MP4_BYTES, mediaType: "video/mp4" }];

export function createAsyncVideoModel(
  o: Partial<{
    modelId: string;
    provider: string;
    specificationVersion: "v4" | "v3";
    maxVideosPerCall: VideoModelLike["maxVideosPerCall"];
    handleWebhookOption: boolean;
    jobId: string;
    webhookSigningSecret: string;
    statuses: readonly StatusStep[];
    repeatLastStatus: boolean;
    onStart: (call: Rec) => void | Promise<void>;
  }> = {},
) {
  const modelId = o.modelId ?? "test/video-async";
  const statuses: readonly StatusStep[] = o.statuses ?? [{ status: "completed", videos: DEF_VID }];
  const [startCalls, statusCalls]: [Rec[], Rec[]] = [[], []];
  const asyncJob = {
    ...(o.jobId !== undefined && { jobId: o.jobId }),
    ...(o.webhookSigningSecret !== undefined && { webhookSigningSecret: o.webhookSigningSecret }),
  };
  const model: VideoModelLike = {
    specificationVersion: o.specificationVersion ?? "v4",
    provider: o.provider ?? "test-provider",
    modelId,
    maxVideosPerCall: o.maxVideosPerCall,
    ...(o.handleWebhookOption && { handleWebhookOption: async () => undefined }),
    async doStart(call) {
      startCalls.push(call);
      await o.onStart?.(call);
      return {
        operation: { id: "op_1" },
        warnings: [],
        response: mkResp(modelId),
        ...(Object.keys(asyncJob).length > 0 && { providerMetadata: { gateway: { asyncJob } } }),
      };
    },
    async doStatus(call) {
      const idx = statusCalls.length;
      statusCalls.push(call);
      const si =
        idx < statuses.length ? idx : (o.repeatLastStatus ?? true) ? statuses.length - 1 : -1;
      if (si < 0) throw new Error(`Unexpected doStatus #${idx + 1}`);
      const step = statuses[si];
      const res = typeof step === "function" ? await step(call, idx) : step;
      return {
        ...res,
        warnings: [...(res.warnings ?? [])],
        ...(res.status === "completed" && { response: mkResp(modelId) }),
      };
    },
  };
  return { model, startCalls, statusCalls };
}

export function createSyncVideoModel(
  o: Partial<{
    modelId: string;
    videos: readonly Asset[];
    onGenerate: (c: Rec) => void | Promise<void>;
  }> = {},
) {
  const modelId = o.modelId ?? "test/video-sync";
  const generateCalls: Rec[] = [];
  const model: VideoModelLike = {
    specificationVersion: "v4",
    provider: "test-provider",
    modelId,
    async doGenerate(call) {
      generateCalls.push(call);
      await o.onGenerate?.(call);
      return { videos: o.videos ?? DEF_VID, warnings: [], response: mkResp(modelId) };
    },
  };
  return { model, generateCalls };
}

export interface FakeSandbox extends Pick<SandboxSession, "readBinaryFile" | "writeBinaryFile"> {
  readonly files: Map<string, Uint8Array>;
}

export function createFakeSandbox(initial?: Readonly<Record<string, Uint8Array>>): FakeSandbox {
  const files = new Map(Object.entries(initial ?? {}).map(([k, v]) => [k, Uint8Array.from(v)]));
  return {
    files,
    readBinaryFile: async ({ path, signal }) => (
      signal?.throwIfAborted(),
      files.has(path) ? Uint8Array.from(files.get(path)!) : null
    ),
    writeBinaryFile: async ({ path, content, signal }) =>
      void (signal?.throwIfAborted(), files.set(path, Uint8Array.from(content))),
  };
}

export function createFakeStepContext(
  o: Partial<{
    sessionId: string;
    callId: string;
    signal: AbortSignal;
    sandbox: FakeSandbox;
    getSandbox: () => Promise<FakeSandbox>;
  }> = {},
): WorkflowStepToolContext {
  return {
    abortSignal: o.signal ?? new AbortController().signal,
    callId: o.callId ?? "call-1",
    toolName: "video__generate",
    session: { id: o.sessionId ?? "session-1" },
    getSandbox:
      o.getSandbox ??
      (o.sandbox ? async () => o.sandbox! : () => Promise.reject(new Error("No sandbox."))),
  } as never;
}

export function createFakeApprovalContext(
  toolInput: GenerateVideoToolInput,
): ApprovalContext<GenerateVideoToolInput> {
  const p = { authenticator: "a", principalType: "user", principalId: "u1", attributes: {} };
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    toolName: "video__generate",
    toolInput,
    session: { id: "s1", auth: { current: p, initiator: p }, turn: { id: "t1", index: 1 } },
  } as never;
}

const ENV_KEYS =
  "VERCEL_BLOB_API_URL EVE_VIDEO_BLOB_STORE_ID EVE_VIDEO_BLOB_READ_WRITE_TOKEN BLOB_STORE_ID BLOB_READ_WRITE_TOKEN VERCEL VERCEL_OIDC_TOKEN EVE_DEV".split(
    " ",
  );

export function clearStorageEnv(overrides?: Readonly<Record<string, string | undefined>>): void {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(overrides ?? {})) if (v !== undefined) process.env[k] = v;
}

export async function withCleanStorageEnv<T>(
  fn: () => Promise<T> | T,
  overrides?: Readonly<Record<string, string | undefined>>,
): Promise<T> {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  clearStorageEnv(overrides);
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}
