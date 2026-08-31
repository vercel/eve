import type { CompiledWorkspaceResourceRoot } from "#compiler/manifest.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";

/**
 * Stable internal source id for the framework-owned default sandbox.
 *
 * Used by the runtime template/session key derivation and by prewarm
 * to distinguish the shared framework sandbox from per-node authored
 * overrides.
 */
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
  /** Parent-owned sandbox identity used by a child that selects parent.sandbox. */
  readonly inheritance?: {
    readonly definition: ResolvedSandboxDefinition;
    readonly nodeId: string;
    readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
  };
}

/**
 * Runtime-owned registry that exposes the resolved sandbox to the harness
 * startup path.
 *
 * Every agent owns exactly one sandbox, so the registry is just a
 * single record populated from the selected compiled sandbox source.
 * Production always populates it; tests that
 * need a `null` sandbox cast through `as RuntimeSandboxRegistry`.
 */
export interface RuntimeSandboxRegistry {
  readonly sandbox: RuntimeRegisteredSandbox;
}

/**
 * Builds the runtime-owned registry for one selected compiled sandbox.
 */
export function createRuntimeSandboxRegistry(input: {
  readonly sandbox: ResolvedSandboxDefinition;
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
}): RuntimeSandboxRegistry {
  const definition = input.sandbox;
  if (
    definition.inheritsParent === true &&
    (input.workspaceResourceRoot.contentHash !== undefined ||
      input.workspaceResourceRoot.rootEntries.length > 0)
  ) {
    throw new Error(
      `Sandbox "${definition.logicalPath}" selects parent.sandbox but has managed workspace resources. Remove the child workspace or give the child its own sandbox.`,
    );
  }
  return {
    sandbox: {
      definition,
      workspaceResourceRoot: input.workspaceResourceRoot,
    },
  };
}
