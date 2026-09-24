import type { CompiledAgentDefinition } from "#compiler/manifest.js";
import type {
  FinalizedNodeSourceState,
  PhaseOneNodeSourceState,
} from "#compiler/node-source-state.js";
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
}

export function applyAgentToolPolicy(
  phaseOne: PhaseOneNodeSourceState,
  config: CompiledAgentDefinition,
): void {
  if (config.tool !== false) return;

  const overridden = phaseOne.graph.orderedCandidates.some(
    (candidate) =>
      candidate.layer !== "framework-default" &&
      canonicalSourceSlot(candidate.logicalPath) === "tools/agent",
  );
  if (overridden) return;

  phaseOne.graph.composed = composeAgentModuleCandidates(
    phaseOne.graph.orderedCandidates.filter(
      (candidate) =>
        candidate.layer !== "framework-default" ||
        canonicalSourceSlot(candidate.logicalPath) !== "tools/agent",
    ),
  );
}

export function canDisableToolWithoutSelectedSource(
  state: FinalizedNodeSourceState,
  toolName: string,
): boolean {
  return state.projected.subagents.some((entry) => entry.source.subagentId === toolName);
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
