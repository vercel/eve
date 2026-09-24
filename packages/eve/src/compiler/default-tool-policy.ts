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

// `defaultTools: false` keeps these: `connection_search` reaches connection
// tools, and `task_cancel` is advertised only with the background-tasks
// instructions that name it.
const KEPT_FRAMEWORK_TOOL_SLOTS = new Set(["tools/connection_search", "tools/task_cancel"]);

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
  if (
    slot === "tools/task_cancel" &&
    result.kind !== "disabled" &&
    !(
      result.kind === "tool" &&
      result.definition.behavior?.handling?.kind === "dispatch" &&
      result.definition.behavior.handling.action === "task-cancel"
    )
  ) {
    throw new Error(
      'The framework "task_cancel" tool cannot be overridden. Re-export it from "eve/tools/task_cancel" or disable it with disableTool().',
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
        KEPT_FRAMEWORK_TOOL_SLOTS.has(slot) ||
        overriddenSlots.has(slot)
      );
    }),
  );
}
