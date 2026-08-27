import type { ModuleSourceRef } from "#shared/source-ref.js";
import {
  collectSelectedSourceIds,
  mergeExternalDependencies,
} from "#compiler/normalize-manifest-helpers.js";
import type {
  ProjectedAgentSources,
  ProjectedSource,
  ProjectedSubagentSource,
} from "#compiler/project-sources.js";
import {
  createAgentModuleBinding,
  type AgentModuleBinding,
  type AgentModuleCandidate,
  type AgentSourceBacking,
  type AgentSourceCandidate,
  type AgentSourceDescriptor,
  type ComposedAgentModuleCandidates,
} from "#compiler/source-graph.js";
import type { NodeModuleEvaluationContext } from "#compiler/module-lifecycle.js";

export interface ComposedNodeSourceGraph {
  composed: ComposedAgentModuleCandidates;
  readonly orderedCandidates: readonly AgentSourceCandidate[];
  readonly projected: ProjectedAgentSources;
  readonly sourcesBySourceId: ReadonlyMap<string, ProjectedSource>;
  readonly subagentsBySourceId: ReadonlyMap<string, ProjectedSubagentSource>;
}

export interface SelectedNodeConfig {
  readonly binding: AgentModuleBinding;
  readonly candidate: AgentModuleCandidate;
  readonly definition: unknown;
  readonly source: ModuleSourceRef;
}

export interface PhaseOneNodeSourceState {
  readonly evaluation: NodeModuleEvaluationContext;
  readonly graph: ComposedNodeSourceGraph;
  readonly selectedConfig: SelectedNodeConfig;
}

export interface FinalizedNodeSourceState extends ComposedNodeSourceGraph {
  readonly bindings: Record<string, AgentModuleBinding>;
  readonly evaluation: NodeModuleEvaluationContext;
}

export function finalizeNodeSourceState(
  phaseOne: PhaseOneNodeSourceState,
  externalDependencies: readonly string[],
): FinalizedNodeSourceState {
  const graph = phaseOne.graph;
  const candidatesBySourceId = new Map(
    graph.orderedCandidates.map((candidate) => {
      const finalized = finalizeCandidateExternalDependencies(candidate, externalDependencies);
      return [candidate.sourceId, finalized] as const;
    }),
  );
  const candidateFor = <TCandidate extends AgentSourceCandidate>(candidate: TCandidate) => {
    const finalized = candidatesBySourceId.get(candidate.sourceId);
    if (finalized === undefined) {
      throw new Error(`Agent source candidate "${candidate.sourceId}" is missing from its node.`);
    }
    return finalized as TCandidate;
  };
  const projected: ProjectedAgentSources = {
    candidates: graph.projected.candidates.map(candidateFor),
    resources: graph.projected.resources.map((entry) => ({
      ...entry,
      candidate: candidateFor(entry.candidate),
    })) as ProjectedAgentSources["resources"],
    subagents: graph.projected.subagents.map((entry) => ({
      ...entry,
      candidate: candidateFor(entry.candidate),
    })),
  };
  const composed: ComposedAgentModuleCandidates = {
    composition: {
      entries: graph.composed.composition.entries.map((entry) => ({
        ...entry,
        source: finalizeDescriptorExternalDependencies(entry.source, externalDependencies),
      })),
    },
    selected: new Map(
      [...graph.composed.selected].map(([slot, candidate]) => [slot, candidateFor(candidate)]),
    ),
  };
  const selectedSourceIds = collectSelectedSourceIds(composed);
  const bindings = Object.fromEntries(
    [...candidatesBySourceId.values()]
      .filter(
        (candidate): candidate is AgentModuleCandidate =>
          selectedSourceIds.has(candidate.sourceId) && candidate.backing.kind !== "resource",
      )
      .map((candidate) => [candidate.sourceId, createAgentModuleBinding(candidate)]),
  );
  phaseOne.evaluation.setBindings(bindings);
  return {
    bindings,
    composed,
    orderedCandidates: graph.orderedCandidates.map(candidateFor),
    projected,
    sourcesBySourceId: new Map(
      [...graph.sourcesBySourceId].map(([sourceId, entry]) => [
        sourceId,
        { ...entry, candidate: candidateFor(entry.candidate) } as ProjectedSource,
      ]),
    ),
    subagentsBySourceId: new Map(
      projected.subagents.map((entry) => [entry.candidate.sourceId, entry]),
    ),
    evaluation: phaseOne.evaluation,
  };
}

function finalizeCandidateExternalDependencies<TCandidate extends AgentSourceCandidate>(
  candidate: TCandidate,
  externalDependencies: readonly string[],
): TCandidate {
  if (candidate.backing.kind !== "filesystem") return candidate;
  return {
    ...candidate,
    backing: finalizeBackingExternalDependencies(candidate.backing, externalDependencies),
  } as TCandidate;
}

function finalizeDescriptorExternalDependencies(
  descriptor: AgentSourceDescriptor,
  externalDependencies: readonly string[],
): AgentSourceDescriptor {
  if (descriptor.backing.kind !== "filesystem") return descriptor;
  return {
    ...descriptor,
    backing: finalizeBackingExternalDependencies(descriptor.backing, externalDependencies),
  };
}

function finalizeBackingExternalDependencies(
  backing: Extract<AgentSourceBacking, { readonly kind: "filesystem" }>,
  externalDependencies: readonly string[],
): Extract<AgentSourceBacking, { readonly kind: "filesystem" }> {
  return {
    ...backing,
    externalDependencies: mergeExternalDependencies(
      externalDependencies,
      backing.externalDependencies,
    ),
  };
}
