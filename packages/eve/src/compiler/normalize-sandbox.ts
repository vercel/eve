import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { SandboxSourceRef } from "#discover/manifest.js";
import { normalizeSandboxDefinition } from "#internal/authored-definition/sandbox.js";
import type { CompiledSandboxDefinition } from "#compiler/manifest.js";
import {
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";
import { toErrorMessage } from "#shared/errors.js";

/**
 * Compiles one authored sandbox module into the normalized sandbox
 * definition stored on the compiled agent manifest.
 */
export async function compileSandboxDefinition(
  agentRoot: string,
  source: SandboxSourceRef,
  options: ModuleBackedDefinitionLoadOptions = {},
): Promise<CompiledSandboxDefinition> {
  const message = `Expected the sandbox export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`;
  const normalized = normalizeSandboxDefinition(
    await loadModuleBackedDefinition({
      agentRoot,
      externalDependencies: options.externalDependencies,
      kind: "sandbox",
      source,
    }),
    message,
  );
  const revalidationKey =
    normalized.revalidationKey === undefined
      ? undefined
      : await resolveSandboxRevalidationKey({
          message,
          revalidationKey: normalized.revalidationKey,
          source,
        });

  return {
    backendName: resolveCompiledBackendName(normalized.backend),
    description: normalized.description,
    exportName: source.exportName,
    logicalPath: source.logicalPath,
    revalidationKey,
    sourceHash: await resolveSandboxSourceHash(agentRoot, source),
    sourceId: source.sourceId,
    sourceKind: "module",
  };
}

/**
 * Captures the authored backend's stable name into the manifest.
 *
 * Reading `.name` forces a lazily-wrapped backend factory exactly once
 * at compile time; a factory that throws here is tolerated (it already
 * fails at runtime, where the error surfaces with full context) and
 * simply leaves the name unrecorded.
 */
function resolveCompiledBackendName(
  backend: { readonly name: string } | undefined,
): string | undefined {
  if (backend === undefined) {
    return undefined;
  }
  try {
    return backend.name;
  } catch {
    return undefined;
  }
}

async function resolveSandboxRevalidationKey(input: {
  readonly message: string;
  readonly revalidationKey: () => Promise<string> | string;
  readonly source: SandboxSourceRef;
}): Promise<string> {
  let resolved: unknown;
  try {
    resolved = await input.revalidationKey();
  } catch (error) {
    throw new Error(
      `${input.message} Failed to execute the "revalidationKey" function from "${input.source.logicalPath}": ${toErrorMessage(error)}`,
    );
  }

  if (typeof resolved !== "string") {
    throw new Error(`${input.message} The "revalidationKey" function must return a string.`);
  }

  if (resolved.trim().length === 0) {
    throw new Error(
      `${input.message} The "revalidationKey" function must return a non-empty string.`,
    );
  }

  return resolved;
}

async function resolveSandboxSourceHash(
  agentRoot: string,
  source: SandboxSourceRef,
): Promise<string> {
  const content = await readFile(join(agentRoot, source.logicalPath));
  return createHash("sha256").update(content).digest("hex");
}
