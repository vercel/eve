import {
  isFreshCodexAccessToken,
  readCodexAuth,
  type CodexAuthSnapshot,
} from "#internal/model-auth/endpoint/codex/auth.js";
import type { ModelEndpointStatus } from "#shared/model-endpoint-status.js";

export interface ResolveCodexEndpointStatusOptions {
  readonly now?: () => number;
  readonly readCodexAuth?: () => Promise<CodexAuthSnapshot>;
}

export async function resolveCodexEndpointStatus(
  options: ResolveCodexEndpointStatusOptions = {},
): Promise<ModelEndpointStatus> {
  const { state, credentials } = await (options.readCodexAuth ?? readCodexAuth)();
  if (credentials === undefined) {
    return {
      kind: "codex",
      connected: false,
      reason: state.kind === "invalid" ? "invalid" : "missing",
    };
  }

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
