import { createHash } from "node:crypto";

import type { CompiledWorkspaceResourceRoot } from "#compiler/manifest.js";
import { defaultSandbox } from "#public/sandbox/backends/default.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";

/**
 * Stable internal source id for the framework-owned default sandbox.
 *
 * Used by the runtime template/session key derivation and by prewarm
 * to distinguish the shared framework sandbox from per-node authored
 * overrides.
 */
export const DEFAULT_SANDBOX_SOURCE_ID = "eve:default-sandbox";

/**
 * Resolved sandbox tracked by the runtime-owned registry.
 *
 * The sandbox does not generate model-visible tools automatically. The
 * framework `bash` tool targets it implicitly.
 *
 * `workspaceResourceRoot` carries the byte-free descriptor for the
 * compiled workspace resource tree owned by this graph node. The
 * prewarm orchestrator resolves the descriptor's logical path against
 * the active compiled artifacts source and writes the contents into
 * the sandbox template snapshot. Runtime `backend.create(...)` never
 * reads these files.
 */
export interface RuntimeRegisteredSandbox {
  readonly definition: ResolvedSandboxDefinition;
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
  readonly workspaceResourceRoots: readonly CompiledWorkspaceResourceRoot[];
}

/**
 * Runtime-owned registry that exposes the resolved sandbox to the harness
 * startup path.
 *
 * Every agent owns exactly one sandbox, so the registry is just a
 * single record. When the author provides a `sandbox.<ext>` (or
 * `sandbox/sandbox.<ext>`) override, that authored definition replaces
 * the framework default. Production always populates it; tests that
 * need a `null` sandbox cast through `as RuntimeSandboxRegistry`.
 */
export interface RuntimeSandboxRegistry {
  readonly sandbox: RuntimeRegisteredSandbox;
}

/**
 * Builds the runtime-owned registry for one resolved authored agent's
 * sandbox, preferring the authored override and falling back to the
 * framework default.
 */
export function createRuntimeSandboxRegistry(input: {
  readonly authoredSandbox: ResolvedSandboxDefinition | null;
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
  readonly workspaceResourceRoots?: readonly CompiledWorkspaceResourceRoot[];
}): RuntimeSandboxRegistry {
  const definition = input.authoredSandbox ?? createFrameworkSandboxDefinition();
  const workspaceResourceRoots = input.workspaceResourceRoots ?? [input.workspaceResourceRoot];
  return {
    sandbox: {
      definition,
      workspaceResourceRoot: mergeWorkspaceResourceRoots(workspaceResourceRoots),
      workspaceResourceRoots,
    },
  };
}

function mergeWorkspaceResourceRoots(
  roots: readonly CompiledWorkspaceResourceRoot[],
): CompiledWorkspaceResourceRoot {
  if (roots.length === 0) {
    return {
      logicalPath: "",
      rootEntries: [],
    };
  }

  if (roots.length === 1) {
    return roots[0]!;
  }

  const hash = createHash("sha256");
  const rootEntries = new Set<string>();
  let hasContent = false;

  hash.update("eve-merged-workspace-resource-root-v1\0");
  for (const root of roots) {
    hash.update(root.logicalPath);
    hash.update("\0");
    hash.update(root.contentHash ?? "");
    hash.update("\0");
    for (const entry of root.rootEntries) {
      rootEntries.add(entry);
      hash.update(entry);
      hash.update("\0");
    }
    if (root.contentHash !== undefined || root.rootEntries.length > 0) {
      hasContent = true;
    }
  }

  return {
    contentHash: hasContent ? hash.digest("hex") : undefined,
    logicalPath: roots[0]!.logicalPath,
    rootEntries: [...rootEntries].sort((left, right) => left.localeCompare(right)),
  };
}

/**
 * Builds the framework default sandbox definition used when no agent
 * authored override is present.
 *
 * The `backend` is resolved through {@link defaultSandbox} on each
 * call so the framework default picks up the same environment-aware
 * fallback as authored sandboxes that omit `backend` (`vercel()`
 * on hosted Vercel, then Docker, microsandbox, or just-bash by availability). Implemented as
 * a factory rather than a constant so the environment is read at
 * graph-resolution time rather than at module-load time.
 */
export function createFrameworkSandboxDefinition(): ResolvedSandboxDefinition {
  return {
    backend: defaultSandbox(),
    logicalPath: "eve:framework/default-sandbox",
    sourceId: DEFAULT_SANDBOX_SOURCE_ID,
    sourceKind: "module",
  };
}
