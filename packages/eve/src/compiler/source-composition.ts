import { z } from "#compiled/zod/index.js";

import {
  agentSourceOwnerSchema,
  compiledModuleBackingSchema,
  type AgentSourceOwner,
  type CompiledModuleBacking,
} from "#compiler/module-binding.js";
export { canonicalAgentSourceSlot } from "#compiler/source-slot.js";

export type AgentSourceLayer = z.infer<typeof agentSourceLayerSchema>;
export type AgentSourceDescriptor = z.infer<typeof agentSourceDescriptorSchema>;
export type AgentSourceComposition = z.infer<typeof agentSourceCompositionSchema>;

export const compiledSubagentSourceSchema = z
  .object({
    backing: compiledModuleBackingSchema,
    entryPath: z.string(),
    logicalPath: z.string(),
    name: z.string(),
    nodeId: z.string(),
    owner: agentSourceOwnerSchema,
    rootPath: z.string(),
    sourceId: z.string(),
    sourceKind: z.literal("subagent"),
  })
  .strict();

export type CompiledSubagentSource = Readonly<z.infer<typeof compiledSubagentSourceSchema>>;

export const agentSourceLayerSchema = z.enum([
  "framework-default",
  "extension-package",
  "extension-override",
  "application",
]);

const agentSourceDescriptorBaseSchema = z.object({
  layer: agentSourceLayerSchema,
  logicalPath: z.string(),
  owner: agentSourceOwnerSchema,
  sourceId: z.string(),
});

const agentModuleSourceDescriptorSchema = agentSourceDescriptorBaseSchema
  .extend({
    backing: compiledModuleBackingSchema,
    exportName: z.string().optional(),
    sourceKind: z.literal("module"),
  })
  .strict();

const agentValueSourceDescriptorSchema = agentSourceDescriptorBaseSchema
  .extend({
    sourceKind: z.enum(["markdown", "skill-package", "workspace"]),
  })
  .strict();

const agentSubagentSourceDescriptorSchema = agentSourceDescriptorBaseSchema
  .extend({
    backing: compiledModuleBackingSchema,
    sourceKind: z.literal("subagent"),
  })
  .strict();

const agentNonModuleSourceDescriptorSchema = z.discriminatedUnion("sourceKind", [
  agentValueSourceDescriptorSchema,
  agentSubagentSourceDescriptorSchema,
]);

export const agentSourceDescriptorSchema = z.discriminatedUnion("sourceKind", [
  agentModuleSourceDescriptorSchema,
  agentValueSourceDescriptorSchema,
  agentSubagentSourceDescriptorSchema,
]);

const selectedModuleSourceSchema = z
  .object({
    slot: z.string(),
    sourceId: z.string(),
    sourceKind: z.literal("module"),
  })
  .strict();

const selectedNonModuleSourceSchema = z
  .object({
    slot: z.string(),
    source: agentNonModuleSourceDescriptorSchema,
    sourceKind: z.literal("non-module"),
  })
  .strict();

export const agentSourceCompositionSchema = z
  .object({
    disabled: z
      .array(
        z
          .object({
            slot: z.string(),
            source: agentSourceDescriptorSchema,
          })
          .strict(),
      )
      .readonly(),
    selected: z
      .array(
        z.discriminatedUnion("sourceKind", [
          selectedModuleSourceSchema,
          selectedNonModuleSourceSchema,
        ]),
      )
      .readonly(),
    shadowed: z
      .array(
        z
          .object({
            slot: z.string(),
            source: agentSourceDescriptorSchema,
            winningSourceId: z.string(),
          })
          .strict(),
      )
      .readonly(),
  })
  .strict();

export interface AgentSourceCandidate {
  readonly descriptor: AgentSourceDescriptor;
  readonly nodeId: string;
  readonly slot: string;
}

const PRECEDENCE: Readonly<Record<AgentSourceLayer, number>> = {
  "framework-default": 0,
  "extension-package": 1,
  "extension-override": 2,
  application: 3,
};

export interface ComposedAgentSourceEntry<
  Candidate extends AgentSourceCandidate = AgentSourceCandidate,
> {
  readonly candidates: readonly Candidate[];
  readonly slot: string;
  readonly winner: Candidate;
}

export function composeAgentSourceCandidates<Candidate extends AgentSourceCandidate>(
  candidates: readonly Candidate[],
): readonly ComposedAgentSourceEntry<Candidate>[] {
  const bySlot = new Map<string, Candidate[]>();

  for (const candidate of candidates) {
    const entries = bySlot.get(candidate.slot) ?? [];
    const duplicate = entries.find(
      (entry) => entry.descriptor.layer === candidate.descriptor.layer,
    );
    if (duplicate !== undefined) {
      throw new Error(
        `Agent node "${candidate.nodeId}" has duplicate ${candidate.descriptor.layer} candidates for "${candidate.slot}": "${duplicate.descriptor.logicalPath}" and "${candidate.descriptor.logicalPath}".`,
      );
    }
    entries.push(candidate);
    bySlot.set(candidate.slot, entries);
  }

  return Object.freeze(
    [...bySlot]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([slot, entries]) => {
        const ordered = [...entries].sort(
          (left, right) => PRECEDENCE[left.descriptor.layer] - PRECEDENCE[right.descriptor.layer],
        );
        return Object.freeze({
          candidates: Object.freeze(ordered),
          slot,
          winner: ordered.at(-1)!,
        });
      }),
  );
}

export function createAgentSourceComposition(
  entries: readonly ComposedAgentSourceEntry[],
  disabledSourceIds: ReadonlySet<string> = new Set(),
): AgentSourceComposition {
  const selected: AgentSourceComposition["selected"][number][] = [];
  const shadowed: AgentSourceComposition["shadowed"][number][] = [];
  const disabled: AgentSourceComposition["disabled"][number][] = [];

  for (const entry of entries) {
    const winner = entry.winner.descriptor;
    if (disabledSourceIds.has(winner.sourceId)) {
      disabled.push({ slot: entry.slot, source: winner });
    } else if (winner.sourceKind === "module") {
      selected.push({ slot: entry.slot, sourceId: winner.sourceId, sourceKind: "module" });
    } else {
      selected.push({ slot: entry.slot, source: winner, sourceKind: "non-module" });
    }

    for (const candidate of entry.candidates) {
      if (candidate === entry.winner) continue;
      shadowed.push({
        slot: entry.slot,
        source: candidate.descriptor,
        winningSourceId: winner.sourceId,
      });
    }
  }

  return {
    disabled: Object.freeze(disabled),
    selected: Object.freeze(selected),
    shadowed: Object.freeze(shadowed),
  };
}

export function createModuleSourceDescriptor(input: {
  readonly backing: CompiledModuleBacking;
  readonly exportName?: string;
  readonly layer: AgentSourceLayer;
  readonly logicalPath: string;
  readonly owner: AgentSourceOwner;
  readonly sourceId: string;
}): Extract<AgentSourceDescriptor, { sourceKind: "module" }> {
  const descriptor: {
    backing: CompiledModuleBacking;
    exportName?: string;
    layer: AgentSourceLayer;
    logicalPath: string;
    owner: AgentSourceOwner;
    sourceId: string;
    sourceKind: "module";
  } = {
    backing: input.backing,
    layer: input.layer,
    logicalPath: input.logicalPath,
    owner: input.owner,
    sourceId: input.sourceId,
    sourceKind: "module",
  };
  if (input.exportName !== undefined) descriptor.exportName = input.exportName;
  return descriptor;
}
