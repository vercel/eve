import {
  isFreshCodexAccessToken,
  readCodexAuth,
  type CodexAuthSnapshot,
} from "#internal/model-auth/endpoint/codex/auth.js";
import { codexModelSlugFromGatewayId } from "#internal/model-auth/endpoint/codex/catalog.js";
import { createCodexSubscriptionModel } from "#internal/model-auth/endpoint/codex/model.js";
import type { ModelEndpointFactory } from "#internal/model-auth/endpoint/model-endpoint-factory.js";
import type { ModelEndpointStatus } from "#shared/model-endpoint-status.js";

export interface ResolveCodexEndpointStatusOptions {
  readonly now?: () => number;
  readonly readCodexAuth?: () => Promise<CodexAuthSnapshot>;
}

/**
 * Serves an `openai/<model>` reference through the local Codex login
 * (`transport: "codex"` on the compiled reference). Connectedness reads
 * `~/.codex/auth.json`: a usable API key, a fresh ChatGPT access token, or a
 * ChatGPT refresh token.
 */
export const codexEndpoint = {
  createModel(reference) {
    const model = codexModelSlugFromGatewayId(reference.id);

    if (model === null) {
      throw new Error(`Codex model auth requires an OpenAI model id, received "${reference.id}".`);
    }

    return createCodexSubscriptionModel({ model });
  },

  async resolveStatus(
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
  },
} satisfies ModelEndpointFactory<ResolveCodexEndpointStatusOptions>;
