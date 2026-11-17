import type { LanguageModel } from "ai";
import { isModelDefinition } from "#models/definition.js";
import type {
  AgentReasoningDefinition,
  EveLanguageModel,
  PublicAgentStaticModelDefinition,
} from "#shared/agent-definition.js";

export function formatLanguageModelGatewayId(model: PublicAgentStaticModelDefinition): string {
  if (typeof model === "string") {
    return model;
  }
  if (isModelDefinition(model)) {
    return model.id;
  }
  const provider = model.provider.split(".")[0];
  const modelId = model.modelId.replace(/^(claude-[a-z]+-\d+)-(\d+)$/, "$1.$2");
  return `${provider}/${modelId}`;
}

export function isRuntimeLanguageModel(value: unknown): value is EveLanguageModel {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const model = value as {
    specificationVersion?: unknown;
    provider?: unknown;
    modelId?: unknown;
    doGenerate?: unknown;
    doStream?: unknown;
  };

  return (
    (model.specificationVersion === "v2" ||
      model.specificationVersion === "v3" ||
      model.specificationVersion === "v4") &&
    typeof model.provider === "string" &&
    typeof model.modelId === "string" &&
    typeof model.doGenerate === "function" &&
    typeof model.doStream === "function"
  );
}

export function toAiSdkLanguageModel(model: string | EveLanguageModel): LanguageModel {
  return model as LanguageModel;
}

export function isAgentReasoningDefinition(value: unknown): value is AgentReasoningDefinition {
  return (
    typeof value === "string" &&
    ["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"].includes(value)
  );
}
