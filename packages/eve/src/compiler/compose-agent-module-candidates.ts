import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { AgentModuleCandidate, AgentSourceLayer } from "#compiler/agent-module-candidate.js";

const PRECEDENCE: Readonly<Record<AgentSourceLayer, number>> = {
  "framework-default": 0,
  "extension-package": 1,
  "extension-override": 2,
  application: 3,
};

export interface AgentModuleCompositionEntry {
  readonly candidates: readonly AgentModuleCandidate[];
  readonly slot: string;
  readonly winner: AgentModuleCandidate;
}

export interface AgentModuleComposition {
  readonly entries: readonly AgentModuleCompositionEntry[];
  readonly winners: readonly AgentModuleCandidate[];
}

export function composeAgentModuleCandidates(
  candidates: readonly AgentModuleCandidate[],
): AgentModuleComposition {
  const candidatesBySlot = new Map<string, AgentModuleCandidate[]>();

  for (const candidate of candidates) {
    const slot = canonicalModuleSlot(candidate.logicalPath);
    const entries = candidatesBySlot.get(slot) ?? [];
    const sameLayer = entries.find((entry) => entry.layer === candidate.layer);
    if (sameLayer !== undefined) {
      throw new Error(
        `Agent node "${candidate.nodeId}" has duplicate ${candidate.layer} candidates for "${slot}": "${sameLayer.logicalPath}" and "${candidate.logicalPath}".`,
      );
    }
    entries.push(candidate);
    candidatesBySlot.set(slot, entries);
  }

  const entries = [...candidatesBySlot]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([slot, slotCandidates]) => {
      const ordered = [...slotCandidates].sort(
        (left, right) => PRECEDENCE[left.layer] - PRECEDENCE[right.layer],
      );
      return Object.freeze({
        candidates: Object.freeze(ordered),
        slot,
        winner: ordered.at(-1)!,
      });
    });

  return Object.freeze({
    entries: Object.freeze(entries),
    winners: Object.freeze(entries.map((entry) => entry.winner)),
  });
}

export function canonicalModuleSlot(logicalPath: string): string {
  const withoutExtension = stripLogicalPathExtension(logicalPath);
  const connectionFolder = withoutExtension.match(/^connections\/([^/]+)\/connection$/);
  if (connectionFolder !== null) return `connections/${connectionFolder[1]}`;
  return withoutExtension === "sandbox/sandbox" ? "sandbox" : withoutExtension;
}
