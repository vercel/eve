import type { CompiledAgentDefinition } from "#compiler/manifest.js";
import type {
  FinalizedNodeSourceState,
  PhaseOneNodeSourceState,
} from "#compiler/node-source-state.js";
import { deriveMemorySlot } from "#compiler/normalize-definitions.js";
import { canonicalSourceSlot, composeAgentModuleCandidates } from "#compiler/source-graph.js";
import { scheduleCollectionToolPrefix } from "#shared/schedule-collection-tools.js";

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

/**
 * A tool file can disable what eve offers under its name with no file beneath it: a subagent's
 * tool, a memory slot's tools, or a schedule collection's.
 */
export function canDisableToolWithoutSelectedSource(
  state: FinalizedNodeSourceState,
  toolName: string,
): boolean {
  return (
    state.projected.subagents.some((entry) => entry.source.subagentId === toolName) ||
    state.orderedCandidates.some(
      (candidate) =>
        candidate.backing.kind !== "resource" &&
        featureToolName(candidate.logicalPath) === toolName,
    )
  );
}

/** The tool file name a memory slot's or schedule collection's tools take. */
function featureToolName(logicalPath: string): string | undefined {
  const slot = canonicalSourceSlot(logicalPath);
  if (slot === "memory" || slot.startsWith("memory/")) return deriveMemorySlot(logicalPath);
  if (slot.startsWith("schedules/")) {
    return scheduleCollectionToolPrefix(slot.slice("schedules/".length));
  }
  return undefined;
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
