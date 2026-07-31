import type { CompiledWorkspaceResourceRoot } from "#compiler/manifest.js";
import { DefaultSandbox } from "#public/sandbox/default.js";
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
 * the sandbox template snapshot. Runtime provider creation never
 * reads these files.
 */
export interface RuntimeRegisteredSandbox {
  readonly definition: ResolvedSandboxDefinition;
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
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
  readonly templateReferences: Readonly<Record<string, unknown>>;
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
}): RuntimeSandboxRegistry {
  const definition =
    input.authoredSandbox ??
    createFrameworkSandboxDefinition({
      hasWorkspace:
        input.workspaceResourceRoot.contentHash !== undefined ||
        input.workspaceResourceRoot.rootEntries.length > 0,
      templateReferences: input.templateReferences,
    });
  return {
    sandbox: {
      definition,
      workspaceResourceRoot: input.workspaceResourceRoot,
    },
  };
}

/**
 * Builds the framework default sandbox definition used when no agent
 * authored override is present.
 *
 * `DefaultSandbox` chooses Vercel when hosted, then Docker, microsandbox, or
 * just-bash by local availability. A managed workspace adds an internal
 * exported template so build prewarming remains explicit in the resolved
 * definition.
 */
export function createFrameworkSandboxDefinition(input: {
  readonly hasWorkspace: boolean;
  readonly templateReferences?: Readonly<Record<string, unknown>>;
}): ResolvedSandboxDefinition {
  const template = input.hasWorkspace ? DefaultSandbox.template() : null;
  return {
    definition: () => (template === null ? DefaultSandbox.create() : template.create()),
    logicalPath: "eve:framework/default-sandbox",
    sourceHash: DEFAULT_SANDBOX_SOURCE_ID,
    sourceId: DEFAULT_SANDBOX_SOURCE_ID,
    sourceKind: "module",
    templates:
      template === null
        ? []
        : [
            {
              exportName: "template",
              reference: input.templateReferences?.template,
              template,
            },
          ],
  };
}
