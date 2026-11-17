import type { EveLanguageModel, ModelRouting } from "#shared/agent-definition.js";
import type { JsonObject } from "#shared/json.js";

const GATEWAY_PROVIDER = "gateway";

export function classifyModelRouting(
  model: string | EveLanguageModel,
  providerOptions?: Record<string, JsonObject>,
): ModelRouting {
  if (typeof model === "string") {
    const routing: ModelRouting = { kind: "gateway", target: gatewayTarget(model) };
    const byok = readByokProvider(providerOptions);
    if (byok !== undefined) routing.byok = byok;
    return routing;
  }

  if (typeof model.provider !== "string") {
    throw new Error("Cannot classify model routing: the authored model has no string `provider`.");
  }
  const modelId = typeof model.modelId === "string" ? model.modelId : "";
  const topLevelProvider = model.provider.split(".")[0]!;

  if (topLevelProvider === GATEWAY_PROVIDER) {
    const routing: ModelRouting = { kind: "gateway", target: gatewayTarget(modelId) };
    const byok = readByokProvider(providerOptions);
    if (byok !== undefined) routing.byok = byok;
    return routing;
  }

  return { kind: "external", provider: topLevelProvider };
}

function gatewayTarget(modelId: string): string {
  return modelId.split("/")[0]!;
}

function readByokProvider(providerOptions?: Record<string, JsonObject>): string | undefined {
  const gatewayOptions = providerOptions?.[GATEWAY_PROVIDER];
  if (
    gatewayOptions === undefined ||
    gatewayOptions === null ||
    typeof gatewayOptions !== "object"
  ) {
    return undefined;
  }
  const byok = (gatewayOptions as Record<string, unknown>).byok;
  if (byok === undefined || byok === null || typeof byok !== "object") {
    return undefined;
  }
  const [provider] = Object.keys(byok as Record<string, unknown>);
  return provider;
}
