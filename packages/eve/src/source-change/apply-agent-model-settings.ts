import type { AgentReasoningDefinition } from "#shared/agent-definition.js";

import { applyAgentConfigStringPath } from "./agent-config-string-path.js";
import { applyModelNameToSource } from "./apply-model-name.js";

export type FieldPatch<T> =
  | { readonly kind: "keep" }
  | { readonly kind: "set"; readonly value: T }
  | { readonly kind: "remove" };

export interface AgentModelSettingsPatch {
  readonly model: FieldPatch<string>;
  readonly reasoning: FieldPatch<AgentReasoningDefinition>;
  readonly gatewayServiceTier: FieldPatch<"priority">;
}

export type AgentModelSetting = "model" | "reasoning" | "fast-mode";

export type AgentModelSettingsEdit =
  | {
      readonly kind: "applied";
      readonly changed: readonly AgentModelSetting[];
      readonly nextSource: string;
    }
  | { readonly kind: "bail"; readonly reason: string; readonly line: number };

/** Applies every model-setting change in memory; callers own the atomic write. */
export async function applyAgentModelSettingsToSource(
  sourceText: string,
  patch: AgentModelSettingsPatch,
): Promise<AgentModelSettingsEdit> {
  let nextSource = sourceText;
  const changed: AgentModelSetting[] = [];

  if (patch.model.kind === "remove") {
    return { kind: "bail", reason: "the required `model` property cannot be removed", line: 1 };
  }
  if (patch.model.kind === "set") {
    const edit = await applyModelNameToSource(nextSource, patch.model.value);
    if (edit.kind === "bail") return edit;
    if (edit.nextSource !== nextSource) changed.push("model");
    nextSource = edit.nextSource;
  }

  if (patch.reasoning.kind !== "keep") {
    const edit = await applyAgentConfigStringPath(
      nextSource,
      ["reasoning"],
      patch.reasoning.kind === "set"
        ? { kind: "set", value: patch.reasoning.value }
        : { kind: "remove" },
    );
    if (edit.kind === "bail") return edit;
    if (edit.nextSource !== nextSource) changed.push("reasoning");
    nextSource = edit.nextSource;
  }

  if (patch.gatewayServiceTier.kind !== "keep") {
    const edit = await applyAgentConfigStringPath(
      nextSource,
      ["modelOptions", "providerOptions", "gateway", "serviceTier"],
      patch.gatewayServiceTier.kind === "set"
        ? { kind: "set", value: patch.gatewayServiceTier.value }
        : { kind: "remove", removable: (value) => value === "priority" },
    );
    if (edit.kind === "bail") return edit;
    if (edit.nextSource !== nextSource) changed.push("fast-mode");
    nextSource = edit.nextSource;
  }

  return { kind: "applied", changed, nextSource };
}
