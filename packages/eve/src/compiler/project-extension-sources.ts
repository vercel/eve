import { join } from "node:path";

import {
  createPathDerivedSourceId,
  type AgentSourceManifest,
  type ResolvedExtensionMount,
} from "#discover/manifest.js";
import { packageStateNamespace } from "#discover/extensions.js";
import { normalizeLogicalPath } from "#discover/filesystem.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import {
  canonicalSlotKey,
  type AgentModuleBacking,
  type AgentSourceOwner,
} from "#compiler/source-graph.js";
import type { ComposedCandidate } from "#compiler/compose-sources.js";

// ---------------------------------------------------------------------------
// Extension projection
// ---------------------------------------------------------------------------

const PROJECTED_SLOT_DIRECTORIES = new Set([
  "tools",
  "channels",
  "connections",
  "skills",
  "schedules",
  "hooks",
  "instructions",
]);

/**
 * Projects one extension-relative logical path into its final
 * consumer-visible logical path: the first path segment under the slot
 * directory gains the `<namespace>__` prefix. Flat instructions files
 * project into the instructions directory so they cannot collide with the
 * consumer's own flat instructions slot.
 */
export function projectExtensionLogicalPath(namespace: string, logicalPath: string): string {
  const normalized = normalizeLogicalPath(logicalPath);
  const [head, ...rest] = normalized.split("/");
  if (head !== undefined && rest.length > 0 && PROJECTED_SLOT_DIRECTORIES.has(head)) {
    return `${head}/${namespace}__${rest.join("/")}`;
  }
  if (head !== undefined && rest.length === 0 && /^instructions\.[^.]+$/.test(head)) {
    return `instructions/${namespace}__${head}`;
  }
  throw new Error(
    `Extension "${namespace}" source "${logicalPath}" does not project onto a supported slot.`,
  );
}

export function buildExtensionCandidates(manifest: AgentSourceManifest): ComposedCandidate[] {
  const candidates: ComposedCandidate[] = [];

  // Sorted by namespace so composition is deterministic when two mounts
  // contribute adjacent slots.
  for (const mount of [...manifest.resolvedExtensions].sort((left, right) =>
    left.namespace.localeCompare(right.namespace),
  )) {
    candidates.push(...buildExtensionMountCandidates(mount, "extension-package"));
    if (mount.overrides !== undefined) {
      candidates.push(...buildExtensionMountCandidates(mount, "extension-override"));
    }
  }

  return candidates;
}

function buildExtensionMountCandidates(
  mount: ResolvedExtensionMount,
  layer: "extension-package" | "extension-override",
): ComposedCandidate[] {
  const manifest = layer === "extension-package" ? mount.manifest : mount.overrides!;
  const namespace = mount.namespace;
  const packageNamespace = packageStateNamespace(mount.packageName);
  // Consumer-authored override files are application-owned and evaluate
  // unscoped; only the extension package's own modules are extension-owned
  // and scoped to the package's source root.
  const owner: AgentSourceOwner =
    layer === "extension-package"
      ? { kind: "extension", namespace, packageName: mount.packageName }
      : { kind: "application" };
  const sourceIdScope =
    layer === "extension-package" ? `ext:${namespace}` : `ext-override:${namespace}`;

  const project = (logicalPath: string): string =>
    projectExtensionLogicalPath(namespace, logicalPath);

  const moduleBacking = (originalLogicalPath: string): AgentModuleBacking => ({
    kind: "filesystem",
    sourcePath: join(manifest.agentRoot, originalLogicalPath),
    externalDependencies: [],
    ...(layer === "extension-package"
      ? { extensionScope: { namespace, sourceRoot: mount.sourceRoot } }
      : {}),
  });

  const base = (originalLogicalPath: string, module: boolean) => {
    const logicalPath = project(originalLogicalPath);
    return {
      layer,
      logicalPath,
      owner,
      slot: canonicalSlotKey(logicalPath),
      sourceId: `${sourceIdScope}:${createPathDerivedSourceId(logicalPath)}`,
      ...(module
        ? { backing: moduleBacking(originalLogicalPath) }
        : { sourcePath: join(manifest.agentRoot, originalLogicalPath) }),
      ...(layer === "extension-package"
        ? { extensionScopePackageNamespace: packageNamespace }
        : {}),
    };
  };

  const projectedModuleRef = <T extends ModuleSourceRef>(ref: T): T => {
    const logicalPath = project(ref.logicalPath);
    return {
      ...ref,
      logicalPath,
      sourceId: `${sourceIdScope}:${createPathDerivedSourceId(logicalPath)}`,
    };
  };

  const candidates: ComposedCandidate[] = [];

  for (const tool of manifest.tools) {
    candidates.push({
      ...base(tool.logicalPath, true),
      kind: "tool",
      ref: projectedModuleRef(tool),
    });
  }
  for (const channel of manifest.channels) {
    candidates.push({
      ...base(channel.logicalPath, true),
      kind: "channel",
      ref: projectedModuleRef(channel),
    });
  }
  for (const connection of manifest.connections) {
    candidates.push({
      ...base(connection.logicalPath, true),
      kind: "connection",
      ref: {
        ...projectedModuleRef(connection),
        connectionName: `${namespace}__${connection.connectionName}`,
      },
    });
  }
  for (const skill of manifest.skills) {
    if (skill.sourceKind === "module") {
      candidates.push({
        ...base(skill.logicalPath, true),
        kind: "skill",
        ref: projectedModuleRef(skill),
      });
      continue;
    }
    const projected = base(skill.logicalPath, false);
    candidates.push({
      ...projected,
      kind: "skill",
      ref:
        skill.sourceKind === "skill-package"
          ? {
              ...skill,
              logicalPath: projected.logicalPath,
              name: `${namespace}__${skill.name}`,
              sourceId: projected.sourceId,
            }
          : { ...skill, logicalPath: projected.logicalPath, sourceId: projected.sourceId },
    });
  }
  for (const schedule of manifest.schedules) {
    if (schedule.sourceKind === "module") {
      candidates.push({
        ...base(schedule.logicalPath, true),
        kind: "schedule",
        ref: projectedModuleRef(schedule),
      });
      continue;
    }
    const projected = base(schedule.logicalPath, false);
    candidates.push({
      ...projected,
      kind: "schedule",
      ref: { ...schedule, logicalPath: projected.logicalPath, sourceId: projected.sourceId },
    });
  }
  for (const instructions of manifest.instructions) {
    if (instructions.sourceKind === "module") {
      candidates.push({
        ...base(instructions.logicalPath, true),
        kind: "instructions",
        ref: projectedModuleRef(instructions),
      });
      continue;
    }
    const projected = base(instructions.logicalPath, false);
    candidates.push({
      ...projected,
      kind: "instructions",
      ref: { ...instructions, logicalPath: projected.logicalPath, sourceId: projected.sourceId },
    });
  }
  for (const hook of manifest.hooks) {
    candidates.push({
      ...base(hook.logicalPath, true),
      kind: "hook",
      ref: projectedModuleRef(hook),
    });
  }
  for (const subagent of manifest.subagents) {
    const subagentId = `${namespace}__${subagent.subagentId}`;
    const logicalPath = `subagents/${subagentId}`;
    const sourceId = `${sourceIdScope}:${createPathDerivedSourceId(logicalPath)}`;
    candidates.push({
      layer,
      logicalPath,
      owner,
      slot: canonicalSlotKey(logicalPath),
      sourceId,
      sourcePath: subagent.entryPath,
      ...(layer === "extension-package"
        ? { extensionScopePackageNamespace: packageNamespace }
        : {}),
      kind: "subagent",
      ref: {
        ...subagent,
        logicalPath,
        sourceId,
        subagentId,
      },
    });
  }

  return candidates;
}
