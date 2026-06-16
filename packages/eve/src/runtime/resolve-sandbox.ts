import type { CompiledSandboxDefinition } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { lazyBackend } from "#execution/sandbox/lazy-backend.js";
import { expectObjectRecord } from "#internal/authored-module.js";
import type { SandboxBackend } from "#public/definitions/sandbox-backend.js";
import { defaultSandbox } from "#public/sandbox/backends/default.js";
import { toErrorMessage } from "#shared/errors.js";
import { loadResolvedModuleExport, ResolveAgentError } from "#runtime/resolve-helpers.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";

/**
 * Resolves one compiled sandbox entry into a runtime-owned definition
 * with live `backend`, `bootstrap`, and `onSession` lifecycle handlers
 * (when present) attached from the authored module.
 *
 * If the authored module omits `backend`, the resolver substitutes
 * {@link defaultSandbox} so the rest of the runtime can rely on a
 * non-null backend value.
 */
export async function resolveSandboxDefinition(
  definition: CompiledSandboxDefinition,
  moduleMap: CompiledModuleMap,
  nodeId: string | undefined,
): Promise<ResolvedSandboxDefinition> {
  try {
    const resolvedExportValue = await loadResolvedModuleExport({
      definition,
      kindLabel: "sandbox",
      moduleMap,
      nodeId,
    });
    const resolvedRecord = expectObjectRecord(
      resolvedExportValue,
      `Expected the sandbox export "${definition.exportName ?? "default"}" from "${definition.logicalPath}" to return an object.`,
    );
    const sandboxDefinition: {
      readonly backend?: unknown;
      readonly bootstrap?: (input: unknown) => Promise<void> | void;
      readonly onSession?: (input: unknown) => Promise<void> | void;
    } = resolvedRecord;

    const backend = resolveBackend(sandboxDefinition.backend, definition.logicalPath);

    return {
      backend,
      bootstrap: sandboxDefinition.bootstrap as ResolvedSandboxDefinition["bootstrap"],
      description: definition.description,
      exportName: definition.exportName,
      logicalPath: definition.logicalPath,
      onSession: sandboxDefinition.onSession as ResolvedSandboxDefinition["onSession"],
      revalidationKey: definition.revalidationKey,
      sourceHash: definition.sourceHash,
      sourceId: definition.sourceId,
      sourceKind: "module",
    };
  } catch (error) {
    if (error instanceof ResolveAgentError) {
      throw error;
    }
    throw new ResolveAgentError(
      `Failed to attach the sandbox lifecycle handlers from "${definition.logicalPath}": ${toErrorMessage(error)}`,
      {
        logicalPath: definition.logicalPath,
        sourceId: definition.sourceId,
      },
    );
  }
}

function resolveBackend(value: unknown, logicalPath: string): SandboxBackend {
  if (value === undefined) {
    return defaultSandbox();
  }

  if (typeof value === "function") {
    return lazyBackend(value as () => SandboxBackend);
  }

  if (typeof value !== "object" || value === null) {
    throw new ResolveAgentError(
      `Sandbox "${logicalPath}" exposed a non-object "backend" field. Use docker(), vercel(), another factory that returns a SandboxBackend value, or a zero-arg callback returning one.`,
      { logicalPath },
    );
  }

  const record = value as Record<string, unknown>;

  if (typeof record.name !== "string" || record.name.length === 0) {
    throw new ResolveAgentError(
      `Sandbox "${logicalPath}" backend is missing a non-empty string "name" identifier.`,
      { logicalPath },
    );
  }

  if (typeof record.create !== "function") {
    throw new ResolveAgentError(
      `Sandbox "${logicalPath}" backend is missing a "create" function.`,
      { logicalPath },
    );
  }

  return record as unknown as SandboxBackend;
}
