import type { CompiledAgentDefinition } from "#compiler/manifest.js";
import type { PhaseOneNodeSourceState } from "#compiler/node-source-state.js";
import { canonicalSourceSlot, composeAgentModuleCandidates } from "#compiler/source-graph.js";

const REQUIRED_FRAMEWORK_TOOL_SLOTS = new Set(["tools/connection_search"]);

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
