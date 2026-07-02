import { codexModelSlugFromGatewayId } from "#internal/model-auth/endpoint/codex/catalog.js";
import { createCodexSubscriptionModel } from "#internal/model-auth/endpoint/codex/model.js";
import type { ModelEndpointFactory } from "#internal/model-auth/endpoint/model-endpoint-factory.js";

/**
 * Serves an `openai/<model>` reference through the local Codex login
 * (`transport: "codex"` on the compiled reference).
 */
export const codexEndpoint = {
  createModel(reference) {
    const model = codexModelSlugFromGatewayId(reference.id);

    if (model === null) {
      throw new Error(`Codex model auth requires an OpenAI model id, received "${reference.id}".`);
    }

    return createCodexSubscriptionModel({ model });
  },
} satisfies ModelEndpointFactory;
