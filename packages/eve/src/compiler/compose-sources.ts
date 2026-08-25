import { join } from "node:path";

import {
  createPathDerivedSourceId,
  type AgentSourceManifest,
  type ChannelSourceRef,
  type ConnectionSourceRef,
  type HookSourceRef,
  type InstructionsSourceRef,
  type LocalSubagentSourceRef,
  type SandboxSourceRef,
  type ScheduleSourceRef,
  type SkillSourceRef,
} from "#discover/manifest.js";
import { buildExtensionCandidates } from "#compiler/project-extension-sources.js";
import { normalizeLogicalPath } from "#discover/filesystem.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import {
  agentSourceLayerPrecedence,
  canonicalSlotKey,
  createProgrammaticSourceId,
  type AgentModuleBacking,
  type AgentSourceLayer,
  type AgentSourceOwner,
  type AgentSourceRegistry,
} from "#compiler/source-graph.js";
import type { AgentSourceComposition, ComposedSourceDescriptor } from "#compiler/manifest.js";

/**
 * Primitive family a composed candidate belongs to, derived from its
 * canonical logical path.
 */
export type ComposedPrimitiveKind =
  | "config"
  | "sandbox"
  | "tool"
  | "channel"
  | "connection"
  | "skill"
  | "schedule"
  | "instructions"
  | "hook"
  | "subagent";

interface ComposedCandidateBase {
  /** Physical backing for module-backed candidates. */
  readonly backing?: AgentModuleBacking;
  /**
   * Package-derived namespace used to scope extension module evaluation at
   * compile time. Mirrors what the module map derives from the binding's
   * extension scope at load time.
   */
  readonly extensionScopePackageNamespace?: string;
  readonly layer: AgentSourceLayer;
  readonly logicalPath: string;
  readonly owner: AgentSourceOwner;
  readonly slot: string;
  readonly sourceId: string;
  /** Physical path for raw (non-module) filesystem resources. */
  readonly sourcePath?: string;
}

export type ComposedCandidate =
  | (ComposedCandidateBase & { readonly kind: "config"; readonly ref: ModuleSourceRef })
  | (ComposedCandidateBase & { readonly kind: "sandbox"; readonly ref: SandboxSourceRef })
  | (ComposedCandidateBase & { readonly kind: "tool"; readonly ref: ModuleSourceRef })
  | (ComposedCandidateBase & { readonly kind: "channel"; readonly ref: ChannelSourceRef })
  | (ComposedCandidateBase & { readonly kind: "connection"; readonly ref: ConnectionSourceRef })
  | (ComposedCandidateBase & { readonly kind: "skill"; readonly ref: SkillSourceRef })
  | (ComposedCandidateBase & { readonly kind: "schedule"; readonly ref: ScheduleSourceRef })
  | (ComposedCandidateBase & { readonly kind: "instructions"; readonly ref: InstructionsSourceRef })
  | (ComposedCandidateBase & { readonly kind: "hook"; readonly ref: HookSourceRef })
  | (ComposedCandidateBase & { readonly kind: "subagent"; readonly ref: LocalSubagentSourceRef });

/**
 * Extension identity threaded into an extension-owned subagent node so the
 * node's own sources compose with extension ownership and scope.
 */
export interface NodeExtensionScope {
  readonly namespace: string;
  readonly packageName: string;
  readonly packageNamespace: string;
  readonly sourceRoot: string;
}

/**
 * Mutable per-node composition state. Selection appends shadowed entries;
 * normalization appends disabled entries after loading a winning disable
 * sentinel. `toComposition()` seals the report for the compiled node.
 */
export class NodeCompositionState {
  readonly #candidatesBySlot: ReadonlyMap<string, readonly ComposedCandidate[]>;
  readonly #disabled: Array<{ disabledBy: ComposedSourceDescriptor; slot: string }> = [];
  readonly #shadowed: Array<{
    loser: ComposedSourceDescriptor;
    slot: string;
    winningSourceId: string;
  }> = [];

  constructor(candidatesBySlot: ReadonlyMap<string, readonly ComposedCandidate[]>) {
    this.#candidatesBySlot = candidatesBySlot;
  }

  recordShadowed(slot: string, loser: ComposedCandidate, winningSourceId: string): void {
    this.#shadowed.push({
      loser: describeCandidate(loser),
      slot,
      winningSourceId,
    });
  }

  /**
   * Records a selected disable sentinel after validating that it targets a
   * lower replaceable candidate. An unmatched disable is an authoring error.
   */
  recordDisabled(winner: ComposedCandidate): void {
    const candidates = this.#candidatesBySlot.get(winner.slot) ?? [];
    const lowerCandidates = candidates.filter(
      (candidate) =>
        agentSourceLayerPrecedence(candidate.layer) < agentSourceLayerPrecedence(winner.layer),
    );
    if (lowerCandidates.length === 0) {
      throw new Error(
        `"${winner.logicalPath}" disables "${winner.slot}", but no lower-precedence source provides it. ` +
          `Remove the disable sentinel or rename the file to a slot that exists.`,
      );
    }
    this.#disabled.push({ disabledBy: describeCandidate(winner), slot: winner.slot });
  }

  toComposition(): AgentSourceComposition {
    return {
      disabled: [...this.#disabled],
      shadowed: [...this.#shadowed],
    };
  }
}

/**
 * The composed effective source set for one agent node: exactly one winner
 * per canonical slot, selected without executing any candidate, plus the
 * open composition state the normalizers append disable records to.
 */
export interface ComposedNodeSources {
  readonly composition: NodeCompositionState;
  readonly config?: ComposedCandidate;
  readonly sandbox?: ComposedCandidate;
  readonly channels: readonly ComposedCandidate[];
  readonly connections: readonly ComposedCandidate[];
  readonly hooks: readonly ComposedCandidate[];
  readonly instructions: readonly ComposedCandidate[];
  readonly schedules: readonly ComposedCandidate[];
  readonly skills: readonly ComposedCandidate[];
  readonly subagents: readonly ComposedCandidate[];
  readonly tools: readonly ComposedCandidate[];
}

/**
 * Composes every source candidate visible from one agent node — framework
 * defaults, extension packages, extension overrides, and the node's own
 * application sources — into one winner per canonical logical slot.
 *
 * Precedence:
 * `framework default < extension package < extension override < application`.
 * Same-layer duplicate candidates for one slot are rejected. Selection never
 * executes a candidate; disable sentinels are detected when the winner loads
 * during normalization.
 */
export function composeNodeSources(input: {
  readonly applicationRegistry?: AgentSourceRegistry;
  readonly composeConfig: boolean;
  readonly isRoot: boolean;
  readonly manifest: AgentSourceManifest;
  readonly nodeExtensionScope?: NodeExtensionScope;
  readonly registry: AgentSourceRegistry;
}): ComposedNodeSources {
  const candidates: ComposedCandidate[] = [
    ...buildRegistryCandidates(input.registry, input.isRoot, "framework-default"),
    ...buildExtensionCandidates(input.manifest),
    ...buildApplicationCandidates(input.manifest, input.nodeExtensionScope),
    ...(input.applicationRegistry === undefined
      ? []
      : buildRegistryCandidates(input.applicationRegistry, input.isRoot, "application")),
  ];

  const candidatesBySlot = new Map<string, ComposedCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.kind === "config" && !input.composeConfig) {
      continue;
    }
    const slotCandidates = candidatesBySlot.get(candidate.slot) ?? [];
    slotCandidates.push(candidate);
    candidatesBySlot.set(candidate.slot, slotCandidates);
  }

  const composition = new NodeCompositionState(candidatesBySlot);
  const winners: ComposedCandidate[] = [];

  for (const [slot, slotCandidates] of candidatesBySlot) {
    const ordered = [...slotCandidates].sort(
      (left, right) =>
        agentSourceLayerPrecedence(right.layer) - agentSourceLayerPrecedence(left.layer),
    );
    const [winner, ...losers] = ordered;
    if (winner === undefined) {
      continue;
    }
    const duplicate = losers.find((loser) => loser.layer === winner.layer);
    if (duplicate !== undefined) {
      throw new Error(
        `Slot "${slot}" has duplicate ${winner.layer} sources: ` +
          `"${winner.logicalPath}" and "${duplicate.logicalPath}" select the same identity.`,
      );
    }
    for (const loser of losers) {
      composition.recordShadowed(slot, loser, winner.sourceId);
    }
    winners.push(winner);
  }

  return {
    composition,
    config: winners.find((candidate) => candidate.kind === "config"),
    sandbox: winners.find((candidate) => candidate.kind === "sandbox"),
    channels: orderWinners(winners, "channel", "framework-first"),
    connections: orderWinners(winners, "connection", "application-first"),
    hooks: orderWinners(winners, "hook", "application-first"),
    instructions: orderWinners(winners, "instructions", "application-first"),
    schedules: orderWinners(winners, "schedule", "application-first"),
    skills: orderWinners(winners, "skill", "application-first"),
    subagents: orderWinners(winners, "subagent", "application-first"),
    tools: orderWinners(winners, "tool", "framework-first"),
  };
}

/**
 * Deterministic winner order within one primitive family. Channels and
 * tools list framework defaults first so route precedence and the
 * advertised tool order match the pre-composition runtime merge; prompt
 * primitives list application sources first so authored content keeps
 * leading extension contributions. Candidate construction emits candidates
 * in framework → extension → application order, so the stable sort
 * preserves in-layer order.
 */
function orderWinners(
  winners: readonly ComposedCandidate[],
  kind: ComposedPrimitiveKind,
  direction: "framework-first" | "application-first",
): ComposedCandidate[] {
  const sign = direction === "framework-first" ? 1 : -1;
  return winners
    .filter((candidate) => candidate.kind === kind)
    .sort(
      (left, right) =>
        sign * (agentSourceLayerPrecedence(left.layer) - agentSourceLayerPrecedence(right.layer)),
    );
}

function describeCandidate(candidate: ComposedCandidate): ComposedSourceDescriptor {
  return {
    backing: candidate.backing,
    layer: candidate.layer,
    logicalPath: candidate.logicalPath,
    owner: candidate.owner,
    sourceId: candidate.sourceId,
    sourcePath: candidate.sourcePath,
  };
}

// ---------------------------------------------------------------------------
// Registry candidates (framework defaults and in-memory application sources)
// ---------------------------------------------------------------------------

function buildRegistryCandidates(
  registry: AgentSourceRegistry,
  isRoot: boolean,
  layer: "framework-default" | "application",
): ComposedCandidate[] {
  const candidates: ComposedCandidate[] = [];

  for (const registration of registry.registrations) {
    if (registration.applyTo === "root" && !isRoot) {
      continue;
    }
    for (const module of registration.source.modules) {
      const logicalPath = module.logicalPath;
      const slot = canonicalSlotKey(logicalPath);
      const sourceId = createProgrammaticSourceId(registration.source.id, logicalPath);
      const ref: ModuleSourceRef = {
        exportName: module.exportName,
        logicalPath,
        sourceId,
        sourceKind: "module",
      };
      const base = {
        backing: {
          kind: "programmatic" as const,
          moduleId: logicalPath,
          registryId: registration.source.id,
          revision: registration.source.revision,
          semanticRevision: module.semanticRevision,
        },
        layer,
        logicalPath,
        owner:
          layer === "framework-default"
            ? { feature: slot, kind: "framework" as const }
            : { kind: "application" as const },
        slot,
        sourceId,
      };
      candidates.push(classifyModuleCandidate(base, ref, logicalPath));
    }
  }

  return candidates;
}

function classifyModuleCandidate(
  base: ComposedCandidateBase,
  ref: ModuleSourceRef,
  logicalPath: string,
): ComposedCandidate {
  const slot = canonicalSlotKey(logicalPath);
  if (slot === "agent") {
    return { ...base, kind: "config", ref };
  }
  if (slot === "sandbox") {
    return { ...base, kind: "sandbox", ref };
  }
  if (logicalPath.startsWith("tools/")) {
    return { ...base, kind: "tool", ref };
  }
  if (logicalPath.startsWith("channels/")) {
    return { ...base, kind: "channel", ref };
  }
  throw new Error(`Programmatic source "${base.sourceId}" selects an unsupported slot "${slot}".`);
}

// ---------------------------------------------------------------------------
// Application candidates
// ---------------------------------------------------------------------------

function buildApplicationCandidates(
  manifest: AgentSourceManifest,
  nodeExtensionScope: NodeExtensionScope | undefined,
): ComposedCandidate[] {
  const owner: AgentSourceOwner =
    nodeExtensionScope === undefined
      ? { kind: "application" }
      : {
          kind: "extension",
          namespace: nodeExtensionScope.namespace,
          packageName: nodeExtensionScope.packageName,
        };
  const layer: AgentSourceLayer = "application";

  const moduleBacking = (logicalPath: string): AgentModuleBacking => ({
    kind: "filesystem",
    sourcePath: join(manifest.agentRoot, logicalPath),
    externalDependencies: [],
    ...(nodeExtensionScope === undefined
      ? {}
      : {
          extensionScope: {
            namespace: nodeExtensionScope.namespace,
            sourceRoot: nodeExtensionScope.sourceRoot,
          },
        }),
  });

  const rewriteSourceId = (logicalPath: string): string =>
    nodeExtensionScope === undefined
      ? createPathDerivedSourceId(logicalPath)
      : `ext:${nodeExtensionScope.namespace}:${createPathDerivedSourceId(logicalPath)}`;

  const moduleRef = <T extends ModuleSourceRef>(ref: T): T => ({
    ...ref,
    sourceId: rewriteSourceId(ref.logicalPath),
  });

  const base = (logicalPath: string, module: boolean) => ({
    layer,
    logicalPath,
    owner,
    slot: canonicalSlotKey(logicalPath),
    sourceId: rewriteSourceId(logicalPath),
    ...(module
      ? { backing: moduleBacking(logicalPath) }
      : { sourcePath: join(manifest.agentRoot, logicalPath) }),
    ...(nodeExtensionScope === undefined
      ? {}
      : { extensionScopePackageNamespace: nodeExtensionScope.packageNamespace }),
  });

  const candidates: ComposedCandidate[] = [];

  if (manifest.configModule !== undefined) {
    candidates.push({
      ...base(manifest.configModule.logicalPath, true),
      kind: "config",
      ref: moduleRef(manifest.configModule),
    });
  }
  if (manifest.sandbox !== null) {
    candidates.push({
      ...base(manifest.sandbox.logicalPath, true),
      kind: "sandbox",
      ref: moduleRef(manifest.sandbox),
    });
  }
  for (const tool of manifest.tools) {
    candidates.push({ ...base(tool.logicalPath, true), kind: "tool", ref: moduleRef(tool) });
  }
  for (const channel of manifest.channels) {
    candidates.push({
      ...base(channel.logicalPath, true),
      kind: "channel",
      ref: moduleRef(channel),
    });
  }
  for (const connection of manifest.connections) {
    candidates.push({
      ...base(connection.logicalPath, true),
      kind: "connection",
      ref: moduleRef(connection),
    });
  }
  for (const skill of manifest.skills) {
    candidates.push({
      ...base(skill.logicalPath, skill.sourceKind === "module"),
      kind: "skill",
      ref:
        skill.sourceKind === "module"
          ? moduleRef(skill)
          : { ...skill, sourceId: rewriteSourceId(skill.logicalPath) },
    });
  }
  for (const schedule of manifest.schedules) {
    candidates.push({
      ...base(schedule.logicalPath, schedule.sourceKind === "module"),
      kind: "schedule",
      ref:
        schedule.sourceKind === "module"
          ? moduleRef(schedule)
          : { ...schedule, sourceId: rewriteSourceId(schedule.logicalPath) },
    });
  }
  for (const instructions of manifest.instructions) {
    candidates.push({
      ...base(instructions.logicalPath, instructions.sourceKind === "module"),
      kind: "instructions",
      ref:
        instructions.sourceKind === "module"
          ? moduleRef(instructions)
          : { ...instructions, sourceId: rewriteSourceId(instructions.logicalPath) },
    });
  }
  for (const hook of manifest.hooks) {
    candidates.push({ ...base(hook.logicalPath, true), kind: "hook", ref: moduleRef(hook) });
  }
  for (const subagent of manifest.subagents) {
    const logicalPath = normalizeLogicalPath(subagent.logicalPath);
    candidates.push({
      ...base(logicalPath, false),
      sourcePath: subagent.entryPath,
      kind: "subagent",
      ref: { ...subagent, sourceId: rewriteSourceId(logicalPath) },
    });
  }

  return candidates;
}
