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

const CONNECTION_TOOLS_SLOT = "tools/connection_tools";
/** Slots of the closed connection tools and the framework module that provides them. */
const CONNECTION_TOOL_SLOTS = new Set([
  CONNECTION_TOOLS_SLOT,
  "tools/connection_search",
  "tools/connection_execute",
]);

/** Rejects authored sources that would replace or disable the connection tools. */
export function assertFrameworkToolPolicy(candidate: AgentSourceCandidate): void {
  if (candidate.layer === "framework-default") return;
  const slot = canonicalSourceSlot(candidate.logicalPath);
  if (!CONNECTION_TOOL_SLOTS.has(slot)) return;
  throw new Error(
    `"agent/${slot}.ts" is reserved. connection_search and connection_execute are framework tools that cannot be replaced or disabled; they exist only while the agent has connections. Rename the file.`,
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
        slot === CONNECTION_TOOLS_SLOT ||
        overriddenSlots.has(slot)
      );
    }),
  );
}
