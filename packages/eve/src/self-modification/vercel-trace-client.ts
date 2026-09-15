import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";

import { ConversationTraceUnavailableError, unavailable } from "./trace-scope.js";

const AGENT_RUNS_URL = "https://vercel.com/api/observability/agent-runs";
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export interface VercelAgentRunsClient {
  getRun(input: { readonly runId: string; readonly trace: boolean }): Promise<unknown>;
}

/** Creates a transport scoped by the deployment's runtime Vercel OIDC credential. */
export function createVercelAgentRunsClient(): VercelAgentRunsClient {
  return {
    async getRun({ runId, trace }) {
      try {
        const token = (await getVercelOidcToken()).trim();
        const scope = oidcScope(token);
        const url = new URL(AGENT_RUNS_URL);
        url.searchParams.set("teamSlug", scope.teamSlug);
        url.searchParams.set("project", scope.project);
        url.searchParams.set("environment", scope.environment);
        url.searchParams.set("runId", runId);
        if (trace) url.searchParams.set("trace", "1");

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          const response = await fetch(url, {
            headers: { authorization: `Bearer ${token}` },
            signal: controller.signal,
          });
          if (!response.ok) throw unavailable();
          return JSON.parse(await readBoundedBody(response));
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        if (error instanceof ConversationTraceUnavailableError) throw error;
        throw unavailable();
      }
    },
  };
}

function oidcScope(token: string): {
  readonly environment: "preview" | "production";
  readonly project: string;
  readonly teamSlug: string;
} {
  const payload = token.split(".")[1];
  if (payload === undefined) throw unavailable();
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      readonly sub?: unknown;
    };
    if (typeof value.sub !== "string") throw unavailable();
    const match = /^owner:([^:]+):project:([^:]+):environment:(preview|production)$/u.exec(
      value.sub,
    );
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
      throw unavailable();
    }
    return {
      environment: match[3] as "preview" | "production",
      project: match[2],
      teamSlug: match[1],
    };
  } catch (error) {
    if (error instanceof ConversationTraceUnavailableError) throw error;
    throw unavailable();
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw unavailable();
  if (response.body === null) throw unavailable();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw unavailable();
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concat(chunks, size));
}

function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
