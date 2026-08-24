import type { CompiledAgentNodeManifest, CompiledAgentResources } from "#compiler/manifest.js";
import type { CompiledDynamicSubagentDefinition } from "#compiler/remote-agent-node.js";
import { canonicalAgentSourceSlot } from "#compiler/source-slot.js";
import {
  ALLOWED_DYNAMIC_INSTRUCTION_EVENTS,
  ALLOWED_DYNAMIC_MODEL_EVENTS,
  ALLOWED_DYNAMIC_SKILL_EVENTS,
  ALLOWED_DYNAMIC_SUBAGENT_EVENTS,
  ALLOWED_DYNAMIC_TOOL_EVENTS,
} from "#shared/dynamic-tool-definition.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

type CompiledNodeResources = CompiledAgentNodeManifest | CompiledAgentResources;

/** Validates exact source-family projections and public identities for one compiled node. */
export function assertCompiledResourceSemantics(
  resources: CompiledNodeResources,
  nodeId: string,
): void {
  if ("config" in resources) {
    assertExactSlot(resources.config.source, "agent", nodeId);
    for (const [label, source] of [
      ["dynamic model resolver", resources.config.dynamicModel],
      ["model source", resources.config.model?.source],
      ["compaction model source", resources.config.compaction?.model?.source],
    ] as const) {
      if (source === undefined) continue;
      assertSameModuleProjection(resources.config.source, source, nodeId, label);
    }
    if (resources.config.dynamicModel !== undefined) {
      assertDynamicEventNames(
        resources.config.dynamicModel.eventNames,
        ALLOWED_DYNAMIC_MODEL_EVENTS,
        "model resolver",
        resources.config.dynamicModel.sourceId,
        nodeId,
      );
    }
  }

  for (const source of resources.dynamicTools) {
    assertDynamicEventNames(
      source.eventNames,
      ALLOWED_DYNAMIC_TOOL_EVENTS,
      "tool resolver",
      source.sourceId,
      nodeId,
    );
  }
  for (const source of resources.dynamicInstructions) {
    assertDynamicEventNames(
      source.eventNames,
      ALLOWED_DYNAMIC_INSTRUCTION_EVENTS,
      "instructions resolver",
      source.sourceId,
      nodeId,
    );
  }
  for (const source of resources.dynamicSkills) {
    assertDynamicEventNames(
      source.eventNames,
      ALLOWED_DYNAMIC_SKILL_EVENTS,
      "skill resolver",
      source.sourceId,
      nodeId,
    );
  }

  for (const route of resources.channelRoutes.effective) {
    assertSlotFamily(route, "channels", nodeId);
  }
  for (const connection of resources.connections) {
    assertSlotFamily(connection, "connections", nodeId);
  }
  for (const source of [...resources.tools, ...resources.dynamicTools]) {
    assertSlotFamily(source, "tools", nodeId);
  }
  for (const source of [...resources.instructions, ...resources.dynamicInstructions]) {
    assertSlotFamily(source, "instructions", nodeId, true);
  }
  for (const source of [...resources.skills, ...resources.dynamicSkills]) {
    assertSlotFamily(source, "skills", nodeId);
  }
  for (const hook of resources.hooks) {
    assertSlotFamily(hook, "hooks", nodeId);
  }
  for (const schedule of resources.schedules) {
    assertSlotFamily(schedule, "schedules", nodeId);
  }
  for (const workspace of resources.sandboxWorkspaces) {
    assertExactSlot(workspace, "sandbox/workspace", nodeId);
  }
  assertExactSlot(resources.sandbox, "sandbox", nodeId);
  for (const mount of resources.extensionMounts) {
    assertSlotFamily(
      { logicalPath: mount.mountLogicalPath, sourceId: mount.mountSourceId },
      "extensions",
      nodeId,
    );
  }
  if (resources.instrumentation.kind === "file") {
    assertExactSlot(resources.instrumentation.entry.source, "instrumentation", nodeId);
  } else if (resources.instrumentation.kind === "providers") {
    for (const entry of resources.instrumentation.entries) {
      assertSlotFamily(entry.source, "instrumentation", nodeId);
    }
  }

  assertUniqueSourceProjection([...resources.tools, ...resources.dynamicTools], "tool", nodeId);
  assertUniqueSourceProjection(
    [...resources.instructions, ...resources.dynamicInstructions],
    "instructions",
    nodeId,
  );
  assertUniqueSourceProjection([...resources.skills, ...resources.dynamicSkills], "skill", nodeId);
  assertUniqueSourceProjection(resources.connections, "connection", nodeId);
  assertUniqueSourceProjection(resources.hooks, "hook", nodeId);
  assertUniqueSourceProjection(resources.schedules, "schedule", nodeId);
  assertUniqueSourceProjection(resources.sandboxWorkspaces, "workspace", nodeId);

  assertUniquePublicIdentity(
    [
      ...resources.tools.map((tool) => ({ identity: tool.name, sourceId: tool.sourceId })),
      ...resources.dynamicTools.map((tool) => ({ identity: tool.slug, sourceId: tool.sourceId })),
    ],
    "tool",
    nodeId,
  );
  assertUniquePublicIdentity(
    resources.connections.map((connection) => ({
      identity: connection.connectionName,
      sourceId: connection.sourceId,
    })),
    "connection",
    nodeId,
  );
  assertUniquePublicIdentity(
    [
      ...resources.skills.map((skill) => ({ identity: skill.name, sourceId: skill.sourceId })),
      ...resources.dynamicSkills.map((skill) => ({
        identity: skill.slug,
        sourceId: skill.sourceId,
      })),
    ],
    "skill",
    nodeId,
  );
  assertUniquePublicIdentity(
    [
      ...resources.instructions.map((instructions) => ({
        identity: instructions.name,
        sourceId: instructions.sourceId,
      })),
      ...resources.dynamicInstructions.map((instructions) => ({
        identity: instructions.slug,
        sourceId: instructions.sourceId,
      })),
    ],
    "instructions",
    nodeId,
  );
  assertUniquePublicIdentity(
    resources.hooks.map((hook) => ({ identity: hook.slug, sourceId: hook.sourceId })),
    "hook",
    nodeId,
  );
  assertUniquePublicIdentity(
    resources.schedules.map((schedule) => ({
      identity: schedule.name,
      sourceId: schedule.sourceId,
    })),
    "schedule",
    nodeId,
  );
}

/** Validates that a dynamic child's resolver is its selected config source. */
export function assertDynamicSubagentConfigResolverSemantics(input: {
  readonly nodeId: string;
  readonly resolver: CompiledDynamicSubagentDefinition;
  readonly resources: CompiledAgentResources;
  readonly subagentLogicalPath: string;
}): void {
  assertDynamicEventNames(
    input.resolver.eventNames,
    ALLOWED_DYNAMIC_SUBAGENT_EVENTS,
    "subagent config resolver",
    input.resolver.sourceId,
    input.nodeId,
  );
  const selected = input.resources.sourceComposition.selected.find(
    (source) => source.sourceKind === "module" && source.sourceId === input.resolver.sourceId,
  );
  const resolverSlot = canonicalAgentSourceSlot(input.resolver.logicalPath);
  const structuralSubagentSlot = canonicalAgentSourceSlot(input.subagentLogicalPath);
  if (
    selected?.sourceKind !== "module" ||
    selected.slot !== resolverSlot ||
    (resolverSlot !== "agent" && resolverSlot !== structuralSubagentSlot)
  ) {
    throw new Error(
      `Compiled dynamic node "${input.nodeId}" config resolver "${input.resolver.sourceId}" is not its selected config source.`,
    );
  }
}

function assertDynamicEventNames(
  eventNames: readonly string[],
  allowedEventNames: ReadonlySet<string>,
  kind: string,
  sourceId: string,
  nodeId: string,
): void {
  const seen = new Set<string>();
  for (const eventName of eventNames) {
    if (!allowedEventNames.has(eventName)) {
      throw new Error(
        `Compiled node "${nodeId}" ${kind} source "${sourceId}" declares unsupported event "${eventName}".`,
      );
    }
    if (seen.has(eventName)) {
      throw new Error(
        `Compiled node "${nodeId}" ${kind} source "${sourceId}" declares event "${eventName}" more than once.`,
      );
    }
    seen.add(eventName);
  }
}

function assertSameModuleProjection(
  expected: ModuleSourceRef,
  actual: ModuleSourceRef,
  nodeId: string,
  label: string,
): void {
  if (
    actual.sourceId !== expected.sourceId ||
    actual.logicalPath !== expected.logicalPath ||
    actual.exportName !== expected.exportName
  ) {
    throw new Error(
      `Compiled node "${nodeId}" ${label} must exactly match config source "${renderProjection(expected)}".`,
    );
  }
}

function assertSlotFamily(
  source: { readonly logicalPath: string; readonly sourceId: string },
  family: string,
  nodeId: string,
  allowFamilyRoot = false,
): void {
  const slot = canonicalAgentSourceSlot(source.logicalPath);
  if (slot.startsWith(`${family}/`) || (allowFamilyRoot && slot === family)) return;
  throw new Error(
    `Compiled node "${nodeId}" projects source "${source.sourceId}" as ${family}, but its logical path identifies slot "${slot}".`,
  );
}

function assertExactSlot(
  source: { readonly logicalPath: string; readonly sourceId: string },
  expectedSlot: string,
  nodeId: string,
): void {
  const slot = canonicalAgentSourceSlot(source.logicalPath);
  if (slot === expectedSlot) return;
  throw new Error(
    `Compiled node "${nodeId}" projects source "${source.sourceId}" as "${expectedSlot}", but its logical path identifies slot "${slot}".`,
  );
}

function assertUniqueSourceProjection(
  sources: readonly { readonly sourceId: string }[],
  kind: string,
  nodeId: string,
): void {
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (!sourceIds.has(source.sourceId)) {
      sourceIds.add(source.sourceId);
      continue;
    }
    throw new Error(
      `Compiled node "${nodeId}" projects source "${source.sourceId}" as a ${kind} more than once.`,
    );
  }
}

function assertUniquePublicIdentity(
  entries: readonly { readonly identity: string; readonly sourceId: string }[],
  kind: string,
  nodeId: string,
): void {
  const sourceByIdentity = new Map<string, string>();
  for (const entry of entries) {
    const existingSourceId = sourceByIdentity.get(entry.identity);
    if (existingSourceId === undefined) {
      sourceByIdentity.set(entry.identity, entry.sourceId);
      continue;
    }
    throw new Error(
      `Compiled node "${nodeId}" gives ${kind} identity "${entry.identity}" to both "${existingSourceId}" and "${entry.sourceId}".`,
    );
  }
}

function renderProjection(source: ModuleSourceRef): string {
  return `${source.logicalPath}#${source.exportName ?? "default"}`;
}
