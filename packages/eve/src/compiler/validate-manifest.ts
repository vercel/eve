import type {
  AgentSourceComposition,
  CompiledAgentManifest,
  CompiledAgentNodeManifest,
  CompiledAgentResources,
  CompiledChannelRoutePlan,
} from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { collectModuleRefsForManifest } from "#compiler/module-map.js";
import type { CompiledModuleBinding } from "#compiler/source-graph.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import {
  EVE_HOST_ROUTE_INVENTORY,
  routeMethodsIntersect,
  routePathPatternsOverlap,
} from "#shared/host-inventory.js";

/**
 * Error raised when a compiled artifact is missing binding, owner,
 * composition, or route provenance. Raised at construction and after schema
 * parsing in every disk and bundled artifact loader, before module-map
 * hydration.
 */
export class CompiledManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompiledManifestValidationError";
  }
}

/**
 * The one semantic validator for compiled agent artifacts. New artifact
 * checks extend this module.
 */
export function validateCompiledAgentManifest(manifest: CompiledAgentManifest): void {
  validateCompiledNodePayload(ROOT_COMPILED_AGENT_NODE_ID, manifest);
  for (const subagent of manifest.subagents) {
    validateCompiledNodePayload(subagent.nodeId, subagent.agent, {
      additionalModuleRefs: subagent.configResolver === undefined ? [] : [subagent.configResolver],
    });
  }
  validateChannelRoutePlan(manifest.channelRoutes, manifest);
}

/**
 * Validates one compiled node payload: every module-backed manifest
 * reference has exactly one binding with an agreeing logical path,
 * extension-owned filesystem bindings carry their extension scope, every
 * binding is referenced, and non-module records carry explicit owners.
 */
export function validateCompiledNodePayload(
  nodeId: string,
  node: CompiledAgentNodeManifest | CompiledAgentResources,
  options: { readonly additionalModuleRefs?: readonly ModuleSourceRef[] } = {},
): void {
  const moduleRefs = [
    ...collectCompileTimeModuleRefs(node),
    ...(options.additionalModuleRefs ?? []),
  ];
  const referencedSourceIds = new Set<string>();

  for (const ref of moduleRefs) {
    referencedSourceIds.add(ref.sourceId);
    const binding = node.bindings[ref.sourceId];
    if (binding === undefined) {
      throw new CompiledManifestValidationError(
        `Compiled node "${nodeId}" references module source "${ref.sourceId}" without a binding.`,
      );
    }
    if (binding.logicalPath !== ref.logicalPath) {
      throw new CompiledManifestValidationError(
        `Compiled node "${nodeId}" binds source "${ref.sourceId}" at "${binding.logicalPath}" ` +
          `but the manifest references it at "${ref.logicalPath}".`,
      );
    }
    validateBindingShape(nodeId, ref.sourceId, binding);
  }

  for (const sourceId of Object.keys(node.bindings)) {
    if (!referencedSourceIds.has(sourceId)) {
      throw new CompiledManifestValidationError(
        `Compiled node "${nodeId}" carries a binding for "${sourceId}" that no manifest reference uses.`,
      );
    }
  }

  validateNonModuleOwners(nodeId, node);
  validateComposition(nodeId, node.sourceComposition);
}

function validateBindingShape(
  nodeId: string,
  sourceId: string,
  binding: CompiledModuleBinding,
): void {
  if (
    binding.owner.kind === "extension" &&
    binding.backing.kind === "filesystem" &&
    binding.backing.extensionScope === undefined
  ) {
    throw new CompiledManifestValidationError(
      `Compiled node "${nodeId}" binds extension-owned source "${sourceId}" without an extension scope.`,
    );
  }
  if (binding.backing.kind === "programmatic") {
    if (binding.backing.revision.length === 0) {
      throw new CompiledManifestValidationError(
        `Compiled node "${nodeId}" binds programmatic source "${sourceId}" without a revision.`,
      );
    }
  }
}

/**
 * Collects every module-backed reference on one compiled node, including
 * compile-time-only module references (module skills, module instructions,
 * module schedules without run handlers) that never enter the runtime module
 * map but still require binding provenance.
 */
function collectCompileTimeModuleRefs(
  node: CompiledAgentNodeManifest | CompiledAgentResources,
): ModuleSourceRef[] {
  const refs = new Map<string, ModuleSourceRef>();
  for (const ref of collectModuleRefsForManifest(node)) {
    refs.set(ref.sourceId, ref);
  }
  if ("config" in node && node.config.dynamicModel !== undefined) {
    refs.set(node.config.dynamicModel.sourceId, node.config.dynamicModel);
  }
  for (const skill of node.skills) {
    if (skill.sourceKind === "module") {
      refs.set(skill.sourceId, {
        logicalPath: skill.logicalPath,
        sourceId: skill.sourceId,
        sourceKind: "module",
      });
    }
  }
  for (const instructions of node.instructions) {
    if (instructions.sourceKind === "module") {
      refs.set(instructions.sourceId, {
        logicalPath: instructions.logicalPath,
        sourceId: instructions.sourceId,
        sourceKind: "module",
      });
    }
  }
  for (const schedule of node.schedules) {
    if (schedule.sourceKind === "module") {
      refs.set(schedule.sourceId, {
        logicalPath: schedule.logicalPath,
        sourceId: schedule.sourceId,
        sourceKind: "module",
      });
    }
  }
  return [...refs.values()];
}

function validateNonModuleOwners(
  nodeId: string,
  node: CompiledAgentNodeManifest | CompiledAgentResources,
): void {
  for (const skill of node.skills) {
    if (skill.sourceKind !== "module" && skill.owner === undefined) {
      throw new CompiledManifestValidationError(
        `Compiled node "${nodeId}" skill "${skill.name}" is missing explicit ownership.`,
      );
    }
  }
  for (const instructions of node.instructions) {
    if (instructions.sourceKind !== "module" && instructions.owner === undefined) {
      throw new CompiledManifestValidationError(
        `Compiled node "${nodeId}" instructions "${instructions.name}" are missing explicit ownership.`,
      );
    }
  }
  for (const schedule of node.schedules) {
    if (schedule.sourceKind !== "module" && schedule.owner === undefined) {
      throw new CompiledManifestValidationError(
        `Compiled node "${nodeId}" schedule "${schedule.name}" is missing explicit ownership.`,
      );
    }
  }
}

function validateComposition(nodeId: string, composition: AgentSourceComposition): void {
  for (const entry of composition.shadowed) {
    if (entry.loser.backing === undefined && entry.loser.sourcePath === undefined) {
      throw new CompiledManifestValidationError(
        `Compiled node "${nodeId}" records shadowed source "${entry.loser.sourceId}" without physical provenance.`,
      );
    }
  }
}

function validateChannelRoutePlan(
  plan: CompiledChannelRoutePlan,
  manifest: CompiledAgentManifest,
): void {
  const rootChannelSourceIds = new Set(manifest.channels.map((channel) => channel.sourceId));
  const effectiveIdentities = new Set<string>();
  const effectiveByPath = new Map<string, Set<string>>();

  for (const route of plan.effective) {
    const identity = `${route.method} ${normalizeRouteIdentityPath(route.urlPath)}`;
    if (effectiveIdentities.has(identity)) {
      throw new CompiledManifestValidationError(
        `Compiled channel route plan contains duplicate effective route "${identity}".`,
      );
    }
    effectiveIdentities.add(identity);
    if (!rootChannelSourceIds.has(route.sourceId)) {
      throw new CompiledManifestValidationError(
        `Compiled channel route plan references source "${route.sourceId}" absent from the compiled channels.`,
      );
    }
    const atPath = effectiveByPath.get(route.urlPath) ?? new Set<string>();
    atPath.add(route.sourceId);
    effectiveByPath.set(route.urlPath, atPath);

    for (const reserved of EVE_HOST_ROUTE_INVENTORY) {
      if (reserved.development) {
        continue;
      }
      if (
        routeMethodsIntersect(route.method, reserved.method) &&
        routePathPatternsOverlap(route.urlPath, reserved.pathPattern)
      ) {
        throw new CompiledManifestValidationError(
          `Compiled channel route "${route.method} ${route.urlPath}" collides with the reserved host route "${reserved.method} ${reserved.pathPattern}".`,
        );
      }
    }
  }

  for (const preflight of plan.preflight) {
    if (preflight.sourceIds.length === 0) {
      throw new CompiledManifestValidationError(
        `Compiled channel preflight for "${preflight.urlPath}" records no causing routes.`,
      );
    }
    const causes = effectiveByPath.get(preflight.urlPath);
    for (const sourceId of preflight.sourceIds) {
      if (causes === undefined || !causes.has(sourceId)) {
        throw new CompiledManifestValidationError(
          `Compiled channel preflight for "${preflight.urlPath}" references source "${sourceId}" without a selected route at that path.`,
        );
      }
    }
  }

  for (const shadowed of plan.shadowed) {
    const winnerExists = plan.effective.some(
      (route) => route.sourceId === shadowed.winningSourceId,
    );
    if (!winnerExists) {
      throw new CompiledManifestValidationError(
        `Compiled channel route plan retains a shadowed route whose winner "${shadowed.winningSourceId}" is not effective.`,
      );
    }
  }
}

function normalizeRouteIdentityPath(urlPath: string): string {
  return urlPath
    .split("/")
    .map((segment) =>
      segment.startsWith(":") || (segment.startsWith("[") && segment.endsWith("]"))
        ? ":param"
        : segment,
    )
    .join("/");
}
