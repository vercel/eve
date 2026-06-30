import {
  isFreshCodexAccessToken,
  readCodexAuthCredentials,
  readCodexAuthState,
  type CodexAuthCredentials,
  type CodexAuthState,
} from "#internal/model-endpoint-auth/codex/auth.js";
import type { ModelEndpointStatus } from "#shared/model-endpoint-status.js";

export type { CodexAuthCredentials, CodexAuthState };

export interface ResolveCodexEndpointStatusOptions {
  readonly now?: () => number;
  readonly readCodexAuthCredentials?: () => Promise<CodexAuthCredentials>;
  readonly readCodexAuthState?: () => Promise<CodexAuthState>;
}

export async function resolveCodexEndpointStatus(
  options: ResolveCodexEndpointStatusOptions = {},
): Promise<ModelEndpointStatus> {
  const state = await (options.readCodexAuthState ?? readCodexAuthState)();
  if (state.kind === "missing") {
    return { kind: "codex", connected: false, reason: "missing" };
  }
  if (state.kind === "invalid") {
    return { kind: "codex", connected: false, reason: "invalid" };
  }

  const credentials = await (options.readCodexAuthCredentials ?? readCodexAuthCredentials)();
  if (credentials.kind === "api-key") {
    return { kind: "codex", connected: true, credential: "api-key" };
  }

  if (
    isFreshCodexAccessToken(credentials.accessToken, (options.now ?? Date.now)()) ||
    credentials.refreshToken !== undefined
  ) {
    return { kind: "codex", connected: true, credential: "chatgpt" };
  }

  return { kind: "codex", connected: false, reason: "refresh-token-missing" };
}
