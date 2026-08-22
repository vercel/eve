import type { AgentModuleCandidate } from "#compiler/agent-module-candidate.js";
import type { AgentModuleComposition } from "#compiler/compose-agent-module-candidates.js";
import type { CompiledSourceComposition, CompiledSourceReference } from "#compiler/manifest.js";
import type { AgentSourceOwner } from "#compiler/module-binding.js";

function toSource(candidate: AgentModuleCandidate): CompiledSourceReference {
  return {
    logicalPath: candidate.logicalPath,
    owner: candidate.owner,
    sourceId: candidate.sourceId,
  };
}

/** Compacts compiler composition state into the provenance projected by inspection. */
export function prepareSourceComposition(input: {
  readonly composition: AgentModuleComposition;
  readonly disabledWinnerSourceIds: ReadonlySet<string>;
}): CompiledSourceComposition {
  const disabled: Array<CompiledSourceComposition["disabled"][number]> = [];
  const shadowed: Array<CompiledSourceComposition["shadowed"][number]> = [];
  const sourceOwners: Record<string, AgentSourceOwner> = {};

  for (const entry of input.composition.entries) {
    sourceOwners[entry.winner.sourceId] = entry.winner.owner;
    if (input.disabledWinnerSourceIds.has(entry.winner.sourceId)) {
      const target = entry.candidates.at(-2);
      disabled.push({
        slot: entry.slot,
        source: toSource(entry.winner),
        target: target === undefined ? undefined : toSource(target),
      });
      if (target !== undefined) {
        for (const candidate of entry.candidates.slice(0, -2)) {
          shadowed.push({ by: toSource(target), slot: entry.slot, source: toSource(candidate) });
        }
      }
      continue;
    }

    for (const candidate of entry.candidates.slice(0, -1)) {
      shadowed.push({
        by: toSource(entry.winner),
        slot: entry.slot,
        source: toSource(candidate),
      });
    }
  }

  return { disabled, shadowed, sourceOwners };
}
