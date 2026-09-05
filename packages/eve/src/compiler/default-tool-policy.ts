import type { CompiledAgentDefinition } from "#compiler/manifest.js";
import type { PhaseOneNodeSourceState } from "#compiler/node-source-state.js";
import type { CompiledToolEntry } from "#compiler/normalize-tool.js";
import {
  canonicalSourceSlot,
  composeAgentModuleCandidates,
  type AgentSourceCandidate,
} from "#compiler/source-graph.js";

const REQUIRED_FRAMEWORK_TOOL_SLOTS = new Set(["tools/connection_search"]);

export function assertFrameworkToolPolicy(
  candidate: AgentSourceCandidate,
  result: CompiledToolEntry,
): void {
  const slot = canonicalSourceSlot(candidate.logicalPath);
  if (slot === "tools/connection_search" && result.kind === "disabled") {
    throw new Error(
      'The required "connection_search" tool cannot be disabled. Remove "agent/tools/connection_search.ts" or export a replacement tool from it.',
    );
  }
  const closedDispatchSlots = {
    "tools/agent": "self-agent",
    "tools/task_cancel": "task-cancel",
    "tools/task_update": "task-update",
  } as const;
  const expectedAction = closedDispatchSlots[slot as keyof typeof closedDispatchSlots];
  if (
    expectedAction !== undefined &&
    result.kind === "tool" &&
    (result.definition.behavior?.handling?.kind !== "dispatch" ||
      result.definition.behavior.handling.action !== expectedAction)
  ) {
    const toolName = slot.slice("tools/".length);
    throw new Error(
      `The framework "${toolName}" tool cannot be overridden. Re-export it from "eve/tools/${toolName}" or disable it with disableTool().`,
    );
  }
}

export function applyDefaultToolPolicy(
  phaseOne: PhaseOneNodeSourceState,
  config: CompiledAgentDefinition,
): void {
  if (config.defaultTools !== false) return;

  const overriddenSlots = new Set(
    phaseOne.graph.orderedCandidates
      .filter((candidate) => candidate.layer !== "framework-default")
      .map((candidate) => canonicalSourceSlot(candidate.logicalPath)),
  );
  phaseOne.graph.composed = composeAgentModuleCandidates(
    phaseOne.graph.orderedCandidates.filter((candidate) => {
      const slot = canonicalSourceSlot(candidate.logicalPath);
      return (
        candidate.layer !== "framework-default" ||
        !slot.startsWith("tools/") ||
        REQUIRED_FRAMEWORK_TOOL_SLOTS.has(slot) ||
        overriddenSlots.has(slot)
      );
    }),
  );
}
