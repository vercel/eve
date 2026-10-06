import type { CompiledAgentDefinition } from "#compiler/manifest.js";
import type {
  FinalizedNodeSourceState,
  PhaseOneNodeSourceState,
} from "#compiler/node-source-state.js";
import {
  canonicalSourceSlot,
  composeAgentModuleCandidates,
  type AgentSourceCandidate,
} from "#compiler/source-graph.js";
import { CATALOG_TOOL_NAMES } from "#protocol/catalog-tools.js";

const CATALOG_TOOL_SLOTS = new Set(CATALOG_TOOL_NAMES.map((name) => `tools/${name}`));

/** Rejects authored sources that would replace or disable the catalog tools. */
export function assertFrameworkToolPolicy(candidate: AgentSourceCandidate): void {
  const slot = canonicalSourceSlot(candidate.logicalPath);
  if (!CATALOG_TOOL_SLOTS.has(slot)) return;
  throw new Error(
    `"agent/${slot}.ts" is reserved. search and execute are framework tools that every agent has; they cannot be replaced or disabled. Rename the file.`,
  );
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
        overriddenSlots.has(slot)
      );
    }),
  );
}
