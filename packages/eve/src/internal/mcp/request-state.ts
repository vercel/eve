import { createHash, randomBytes } from "node:crypto";

import {
  createRequestStateCodec,
  type McpRequestHandlerExtra,
} from "#compiled/@modelcontextprotocol/server/index.js";

import type { InvokeToolSignIn } from "#channel/invoke-tool.js";
import type { SessionAuthContext } from "#channel/types.js";
import { EVE_DEV_ENV_FLAG } from "#internal/application/dev-environment.js";

/** Environment variable holding the deployment's MCP `requestState` HMAC secret. */
export const MCP_REQUEST_STATE_SECRET_ENV = "EVE_MCP_REQUEST_STATE_SECRET";

/** Shortest accepted secret, in UTF-8 bytes. The SDK codec enforces the same floor. */
const SECRET_MIN_BYTES = 32;

/** How long a round stays answerable, from the first time it is asked. */
const TTL_MS = 10 * 60 * 1000;

/**
 * What eve signs into an MCP `requestState`. The codec signs, it does not
 * encrypt, so the client can read it: the arguments and the caller are
 * hashes. A valid signature grants nothing. It proves eve asked this caller
 * about this call; `invokeTool` evaluates approval again on every retry.
 */
export interface McpRequestStatePayload {
  readonly v: 1;
  /** Which round minted the state: an approval question or a sign-in. */
  readonly kind: "approval" | "authorization";
  readonly callId: string;
  readonly tool: string;
  /** {@link hashToolArguments} of the call's arguments. */
  readonly args: string;
  /** {@link hashCaller} of the caller the round asked. */
  readonly caller: string;
  /** The approval answer a sign-in round carries, so the client answers once. */
  readonly approval?: { readonly approved: boolean };
  /** The sign-ins an `authorization` round asked for, resent unchanged when one is unanswered. */
  readonly signIns?: readonly InvokeToolSignIn[];
  /**
   * When the round ends, in epoch milliseconds. Kept when a sign-in round is
   * sent again, so answering in parts never extends it.
   */
  readonly expiresAt: number;
}

/** Mints and verifies eve's MCP `requestState`, or says why it cannot. */
export type McpRequestState =
  | {
      readonly kind: "codec";
      mint(
        payload: Omit<McpRequestStatePayload, "expiresAt"> & { expiresAt?: number },
      ): Promise<string>;
      /** Pass as the SDK's `requestState.verify`: a throw answers the client `-32602`. */
      verify(state: string, ctx: McpRequestHandlerExtra): Promise<McpRequestStatePayload>;
    }
  | { readonly kind: "missing"; readonly reason: string };

let developmentKey: Uint8Array | undefined;

/**
 * The channel's codec, resolved once. A bad `option` throws right away;
 * the environment variable is read on first use.
 */
export function mcpRequestStateSource(option: string | undefined): () => McpRequestState {
  let resolved = option === undefined ? undefined : resolveMcpRequestState(option);
  return () => (resolved ??= resolveMcpRequestState(undefined));
}

/**
 * Resolves the codec from the channel option, else
 * {@link MCP_REQUEST_STATE_SECRET_ENV}. A too-short option throws, since that
 * is an authoring error; a too-short or absent variable is `missing`, so
 * tools that never pause keep working. Under `eve dev`, one process serves
 * every round, so a per-process random key stands in.
 */
export function resolveMcpRequestState(
  option: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): McpRequestState {
  if (option !== undefined) {
    const problem = secretProblem(option);
    if (problem !== undefined) throw new Error(`mcpChannel requestStateSecret ${problem}`);
    return createCodec(option);
  }
  const fromEnv = env[MCP_REQUEST_STATE_SECRET_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    const problem = secretProblem(fromEnv);
    if (problem === undefined) return createCodec(fromEnv);
    return { kind: "missing", reason: `${MCP_REQUEST_STATE_SECRET_ENV} ${problem}` };
  }
  if (env[EVE_DEV_ENV_FLAG] === "1") {
    developmentKey ??= new Uint8Array(randomBytes(32));
    return createCodec(developmentKey);
  }
  return {
    kind: "missing",
    reason: `Set ${MCP_REQUEST_STATE_SECRET_ENV} (at least ${SECRET_MIN_BYTES} bytes, the same value on every instance) so MCP calls can ask for approval or sign-in.`,
  };
}

function secretProblem(secret: string): string | undefined {
  const bytes = Buffer.byteLength(secret, "utf8");
  if (bytes >= SECRET_MIN_BYTES) return undefined;
  return `must be at least ${SECRET_MIN_BYTES} bytes (got ${bytes}).`;
}

function createCodec(key: string | Uint8Array): McpRequestState {
  // The SDK's own expiry is a backstop; `expiresAt` is the one that holds
  // across re-sent rounds.
  const codec = createRequestStateCodec<unknown>({ key, ttlSeconds: TTL_MS / 1000 });
  return {
    kind: "codec",
    async mint(payload) {
      return await codec.mint({ ...payload, expiresAt: payload.expiresAt ?? Date.now() + TTL_MS });
    },
    async verify(state, ctx) {
      const payload = await codec.verify(state, ctx);
      if (!isPayload(payload)) throw new Error("malformed");
      if (payload.expiresAt <= Date.now()) throw new Error("expired");
      return payload;
    },
  };
}

function isPayload(value: unknown): value is McpRequestStatePayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  if (payload.v !== 1 || typeof payload.expiresAt !== "number") return false;
  if (payload.kind !== "approval" && payload.kind !== "authorization") return false;
  return (["callId", "tool", "args", "caller"] as const).every(
    (field) => typeof payload[field] === "string",
  );
}

/** `sha256` (hex) of the canonical JSON of a call's arguments. */
export function hashToolArguments(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args), "utf8").digest("hex");
}

/** `sha256` (hex) of who the caller is, by the fields that name a principal. */
export function hashCaller(auth: SessionAuthContext): string {
  const { authenticator, issuer, principalId, principalType } = auth;
  return hashToolArguments({ authenticator, issuer, principalId, principalType });
}

/** JSON with object keys sorted at every depth, so equal arguments hash equal. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(",")}}`;
}
