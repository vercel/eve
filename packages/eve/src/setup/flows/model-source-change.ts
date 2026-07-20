import { join } from "node:path";

import { createCompiledRuntimeModelCatalogLoader } from "#compiler/model-catalog.js";
import { discoverAgent } from "#discover/discover-agent.js";
import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import type { AgentReasoningDefinition } from "#shared/agent-definition.js";
import type {
  AgentModelSetting,
  AgentModelSettingsPatch,
} from "#source-change/apply-agent-model-settings.js";
import { createStaticSourceChange } from "#source-change/static-source-change.js";

import pc from "picocolors";

export type ApplyModelSettingsOutcome =
  | {
      kind: "changed";
      changed: readonly AgentModelSetting[];
      model?: string;
      reasoning?: AgentReasoningDefinition | null;
      fastMode?: boolean;
    }
  | { kind: "unchanged" }
  | { kind: "rejected"; message: string };

export function formatApplyModelSettingsOutcome(outcome: ApplyModelSettingsOutcome): string {
  if (outcome.kind === "rejected") return outcome.message;
  if (outcome.kind === "unchanged") return "Model settings are already up to date.";
  if (
    outcome.changed.length === 1 &&
    outcome.changed[0] === "model" &&
    outcome.model !== undefined
  ) {
    return `Model changed to ${pc.bold(outcome.model)}. Live on your next prompt.`;
  }
  const labels = outcome.changed.map((setting) => {
    if (setting === "model") return `model ${outcome.model ?? "updated"}`;
    if (setting === "reasoning") return `reasoning ${outcome.reasoning ?? "provider default"}`;
    return `Fast mode ${outcome.fastMode ? "on" : "off"}`;
  });
  return `Model settings updated: ${labels.join(", ")}. Live on your next prompt.`;
}

/** The outcome of applying a model slug to the agent's authored source. */
export type ApplyModelOutcome =
  | { kind: "changed"; to: string }
  | { kind: "unchanged"; model: string }
  | { kind: "rejected"; message: string };

/** The one-line transcript form of an apply outcome (`/model <slug>`'s reply). */
export function formatApplyModelOutcome(outcome: ApplyModelOutcome): string {
  switch (outcome.kind) {
    case "changed":
      return `Model changed to ${pc.bold(outcome.to)}. Live on your next prompt.`;
    case "unchanged":
      return `Model is already \`${outcome.model}\`.`;
    case "rejected":
      return outcome.message;
  }
}

/** Applies one completed `/model` draft through a single atomic source write. */
export async function changeAgentModelSettings(input: {
  readonly appRoot: string;
  readonly patch: AgentModelSettingsPatch;
}): Promise<ApplyModelSettingsOutcome> {
  const { appRoot, patch } = input;
  if (patch.model.kind === "set") {
    const rejection = await validateModelSlug(appRoot, patch.model.value);
    if (rejection !== null) return { kind: "rejected", message: rejection };
  }

  const agentRoot = join(appRoot, "agent");
  const { manifest } = await discoverAgent({ agentRoot, appRoot });
  const result = await createStaticSourceChange(manifest).updateModelSettings(patch);
  if (result.kind === "bail") {
    return {
      kind: "rejected",
      message: `Couldn't edit ${result.at.logicalPath}: ${result.reason}. Change the model settings by hand.`,
    };
  }
  if (result.changed.length === 0) return { kind: "unchanged" };

  const outcome: Extract<ApplyModelSettingsOutcome, { kind: "changed" }> = {
    kind: "changed",
    changed: result.changed,
  };
  if (patch.model.kind === "set") outcome.model = patch.model.value;
  if (patch.reasoning.kind !== "keep") {
    outcome.reasoning = patch.reasoning.kind === "set" ? patch.reasoning.value : null;
  }
  if (patch.gatewayServiceTier.kind !== "keep") {
    outcome.fastMode = patch.gatewayServiceTier.kind === "set";
  }
  return outcome;
}

/** Applies a validated `/model <slug>` change to authored source. */
export async function changeAgentModel(input: {
  readonly appRoot: string;
  readonly slug: string;
}): Promise<ApplyModelOutcome> {
  const { appRoot, slug } = input;
  const rejection = await validateModelSlug(appRoot, slug);
  if (rejection !== null) return { kind: "rejected", message: rejection };

  const agentRoot = join(appRoot, "agent");
  const { manifest } = await discoverAgent({ agentRoot, appRoot });
  const result = await createStaticSourceChange(manifest).updateModelName(slug);
  if (result.kind === "bail") {
    return {
      kind: "rejected",
      message: `Couldn't edit ${result.at.logicalPath}: ${result.reason}. Change \`model\` by hand.`,
    };
  }
  return result.from === result.to
    ? { kind: "unchanged", model: result.to }
    : { kind: "changed", to: result.to };
}

async function validateModelSlug(appRoot: string, slug: string): Promise<string | null> {
  if (!slug.includes("/")) {
    return `\`${slug}\` isn't a provider/model id (e.g. anthropic/claude-sonnet-5).`;
  }

  const catalog = createCompiledRuntimeModelCatalogLoader(appRoot);
  try {
    const limits = await catalog.getModelLimits(formatLanguageModelGatewayId(slug));
    if (limits === null) {
      return `I couldn't confirm \`${slug}\` in the AI Gateway model catalog, so I didn't change agent.ts.`;
    }
  } catch {
    return null;
  }
  return null;
}
