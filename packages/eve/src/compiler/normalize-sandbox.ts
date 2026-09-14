import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolveSandboxDockerfile } from "#execution/sandbox/dockerfile.js";
import type { CompiledSandboxDefinition } from "#compiler/manifest.js";
import type { ModuleBackedDefinitionLoadOptions } from "#compiler/normalize-helpers.js";
import type { SandboxSourceRef } from "#discover/manifest.js";
import { getAuthoredModuleExport } from "#internal/authored-module.js";
import { getBoundSandboxEnvironment, isSandboxEnvironment } from "#shared/sandbox-environment.js";

const PARENT = Symbol.for("eve.sandbox-parent-definition");
const SELECTOR = Symbol.for("eve.sandbox-selector");

export async function compileSandboxDefinition(
  _agentRoot: string,
  source: SandboxSourceRef,
  options: ModuleBackedDefinitionLoadOptions,
): Promise<CompiledSandboxDefinition> {
  const namespace = await options.loadNamespace(source.sourceId);
  const selector = getAuthoredModuleExport(namespace, source);
  if (typeof selector !== "function" || Reflect.get(selector, SELECTOR) !== true)
    throw new Error(`Expected sandbox "${source.logicalPath}" to default-export defineSandbox().`);
  const inheritsParent = Reflect.get(selector, PARENT) === true;
  const candidate = isSandboxEnvironment(namespace.environment)
    ? namespace.environment
    : getBoundSandboxEnvironment(selector);
  if (!inheritsParent && candidate === undefined)
    throw new Error(`Sandbox "${source.logicalPath}" must export an environment.`);
  const dockerfile =
    candidate?.kind === "dockerfile" ? await resolveSandboxDockerfile(_agentRoot) : undefined;
  if (candidate?.kind === "dockerfile" && dockerfile === undefined)
    throw new Error(
      `Sandbox "${source.logicalPath}" uses a Dockerfile environment, but agent/sandbox/Dockerfile was not found.`,
    );
  const value =
    options.binding.backing.kind === "programmatic"
      ? (options.binding.backing.semanticRevision ?? options.binding.backing.revision)
      : await readFile(options.binding.backing.sourcePath);
  return {
    providerName: candidate?.provider,
    dockerfileHash: dockerfile?.contentHash,
    environmentExportName: isSandboxEnvironment(namespace.environment) ? "environment" : undefined,
    exportName: source.exportName,
    inheritsParent: inheritsParent || undefined,
    logicalPath: source.logicalPath,
    sourceHash: createHash("sha256").update(value).digest("hex"),
    sourceId: source.sourceId,
    sourceKind: "module",
  };
}
