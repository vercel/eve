import { isObject } from "#shared/guards.js";
import {
  extractCodexAccountIdFromToken,
  extractCodexAccountLabelFromToken,
  readCodexJwtExpirationMs,
} from "./auth.js";

export const CHATGPT_ISSUER = "https://auth.openai.com";
// OpenAI's public OAuth client, also used by fx and opencode; no client secret.
export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_LOGIN_HINT =
  "Open `/model` in `eve dev` and select ChatGPT subscription to sign in.";

export interface ChatGptCredentials {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly accountId?: string;
  readonly accountLabel?: string;
}

export class ChatGptSignInRequiredError extends Error {
  constructor() {
    super(`ChatGPT subscription login expired or was revoked. ${CHATGPT_LOGIN_HINT}`);
  }
}

export async function requestChatGptTokens(
  parameters: Record<string, string>,
  options: {
    fetch?: typeof fetch;
    signal?: AbortSignal;
    previous?: ChatGptCredentials;
    now?: () => number;
  } = {},
): Promise<ChatGptCredentials> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${CHATGPT_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CHATGPT_CLIENT_ID, ...parameters }),
      signal,
      redirect: "error",
    });
  } catch {
    options.signal?.throwIfAborted();
    throw new Error("Could not reach ChatGPT authentication. Check your connection and retry.");
  }
  if (!response.ok) {
    if (options.previous && [400, 401, 403].includes(response.status)) {
      throw new ChatGptSignInRequiredError();
    }
    throw new Error(
      `ChatGPT authentication failed (HTTP ${response.status}). Retry sign-in from /model.`,
    );
  }
  const value = await readChatGptAuthResponse(response);
  const accessToken =
    isObject(value) && typeof value.access_token === "string" ? value.access_token : undefined;
  const refreshToken =
    isObject(value) && typeof value.refresh_token === "string"
      ? value.refresh_token
      : options.previous?.refreshToken;
  if (!accessToken || !refreshToken || !isObject(value)) {
    throw new Error(
      "ChatGPT authentication did not return a usable session. Retry sign-in from /model.",
    );
  }
  const idToken = typeof value.id_token === "string" ? value.id_token : undefined;
  const accountId =
    extractCodexAccountIdFromToken(idToken) ??
    extractCodexAccountIdFromToken(accessToken) ??
    options.previous?.accountId;
  const accountLabel =
    extractCodexAccountLabelFromToken(idToken) ??
    extractCodexAccountLabelFromToken(accessToken) ??
    options.previous?.accountLabel;
  const now = (options.now ?? Date.now)();
  const expiresAt =
    typeof value.expires_in === "number" &&
    Number.isFinite(value.expires_in) &&
    value.expires_in > 0
      ? now + value.expires_in * 1000
      : (readCodexJwtExpirationMs(accessToken) ?? now + 3600_000);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error(
      "ChatGPT authentication returned an expired session. Retry sign-in from /model.",
    );
  }
  return {
    accessToken,
    refreshToken,
    expiresAt,
    ...(accountId && { accountId }),
    ...(accountLabel && { accountLabel }),
  };
}

export async function readChatGptAuthResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader)
    throw new Error("ChatGPT authentication returned an empty response. Retry from /model.");
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 64 * 1024) throw new Error("Response too large.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error("ChatGPT authentication returned an invalid response. Retry from /model.");
  } finally {
    reader.releaseLock();
  }
}
