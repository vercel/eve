import type { CompiledInstrumentationPlan } from "#compiler/manifest.js";
import type { EffectiveAgentSourceCandidate } from "#compiler/effective-agent-source-graph.js";
import {
  isEffectiveModuleSource,
  type EffectiveAgentNodeSourceGraph,
} from "#compiler/effective-agent-source-graph.js";
import { normalizeSelectedSource } from "#compiler/normalize-helpers.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

/** Projects selected instrumentation primitives into their runtime activation plan. */
export async function createCompiledInstrumentationPlan(input: {
  readonly graph: EffectiveAgentNodeSourceGraph;
  readonly isRoot: boolean;
  readonly providersEnabled: boolean;
}): Promise<CompiledInstrumentationPlan> {
  if (!input.isRoot) return { kind: "none" };
  const candidates = input.graph.winners.filter(
    (candidate) =>
      candidate.kind === "instrumentation" &&
      input.graph.bindings[candidate.descriptor.sourceId] !== undefined,
  );

  if (!input.providersEnabled) {
    const candidate = candidates[0];
    if (candidate === undefined) return { kind: "none" };
    if (candidates.length !== 1) {
      throw new Error("Root instrumentation file composition must select exactly one source.");
    }
    return await normalizeSelectedSource(
      toInstrumentationNormalizationSource(candidate),
      async () => ({
        entry: {
          activation: candidate.descriptor.owner.kind === "framework" ? "development" : "always",
          implementation:
            candidate.descriptor.owner.kind === "framework" ? "local-tracing" : "config",
          source: toInstrumentationModuleRef(candidate),
        },
        kind: "file" as const,
      }),
    );
  }

  return {
    entries: (
      await Promise.all(
        candidates.map((candidate) =>
          normalizeSelectedSource(toInstrumentationNormalizationSource(candidate), async () => {
            const slot = candidate.slot.slice("instrumentation/".length);
            let activation: "always" | "development" | "production" = "always";
            if (candidate.descriptor.owner.kind === "framework") {
              if (slot === "agent-runs") activation = "production";
              else if (slot === "local") activation = "development";
              else {
                throw new Error(`Framework instrumentation slot "${slot}" has no activation plan.`);
              }
            }
            return {
              activation,
              implementation: "provider" as const,
              slot,
              source: toInstrumentationModuleRef(candidate),
            };
          }),
        ),
      )
    ).sort((left, right) => left.slot.localeCompare(right.slot)),
    kind: "providers",
  };
}

function toInstrumentationNormalizationSource(candidate: EffectiveAgentSourceCandidate): {
  readonly kind: "instrumentation";
  readonly logicalPath: string;
  readonly nodeId: string;
  readonly sourceId: string;
  readonly sourcePath?: string;
} {
  const backing = "backing" in candidate.descriptor ? candidate.descriptor.backing : undefined;
  const source = {
    kind: "instrumentation",
    logicalPath: candidate.descriptor.logicalPath,
    nodeId: candidate.nodeId,
    sourceId: candidate.descriptor.sourceId,
  } as const;
  return backing?.kind === "filesystem" ? { ...source, sourcePath: backing.sourcePath } : source;
}

function toInstrumentationModuleRef(candidate: EffectiveAgentSourceCandidate): ModuleSourceRef {
  if (!isEffectiveModuleSource(candidate.source)) {
    throw new Error(
      `Instrumentation source "${candidate.descriptor.sourceId}" must be module-backed.`,
    );
  }
  return { ...candidate.source };
}
