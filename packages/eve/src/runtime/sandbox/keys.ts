import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { CompileMetadata } from "#compiler/artifacts.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  getRuntimeCompiledArtifactsSandboxAppRoot,
  getRuntimeCompiledArtifactsCacheKey,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { loadCompileMetadata } from "#runtime/loaders/compile-metadata.js";
import { resolveVercelProjectIdFromEnvironment } from "#shared/vercel-project.js";
import type { RuntimeSandboxTemplatePlan } from "#runtime/sandbox/template-plan.js";

/*
 * Template keys include this version for sandbox runtime contract changes
 * that are not captured by revision or resource hashes. Version 9 moves native
 * identity and preparation input discovery into providers.
 */
const RUNTIME_SANDBOX_CONTRACT_VERSION = 9;

/**
 * Input for deriving the stable runtime keys used for one sandbox definition.
 */
/**
 * Creates the stable private artifact-storage key for one sandbox definition.
 *
 * The template key factors in the graph `nodeId` so that two
 * runtime agents (root and subagents) do not collide on the same
 * template when they each own a sandbox authored at the same logical
 * path.
 */
export async function createRuntimeSandboxTemplateKey(input: {
  readonly providerName: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly configurationHash?: string;
  readonly nodeId: string;
  readonly sourceId: string;
  readonly templatePlan: RuntimeSandboxTemplatePlan;
}): Promise<string> {
  return buildRuntimeSandboxTemplateKey(input, await deriveRuntimeSandboxKeyParts(input));
}

/**
 * The facts both keys derive from, computed once per derivation:
 * compile metadata, the partition scope, and the sandbox generation hash
 * (`null` when the sandbox needs no template).
 */
interface RuntimeSandboxKeyParts {
  readonly metadata: CompileMetadata | null;
  readonly scope: string;
  readonly templateHash: string;
}

async function deriveRuntimeSandboxKeyParts(input: {
  readonly providerName: string;
  readonly configurationHash?: string;
  readonly environmentConfigurationHash?: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId: string;
  readonly sourceId: string;
  readonly templatePlan: RuntimeSandboxTemplatePlan;
}): Promise<RuntimeSandboxKeyParts> {
  const metadata = await loadCompileMetadataForKeys(input.compiledArtifactsSource);
  const scope = await resolveRuntimeSandboxScope(input);
  const templateHash = createStableHash(
    `${resolveRuntimeSandboxTemplateHash({
      nodeId: input.nodeId,
      sourceId: input.sourceId,
      templatePlan: input.templatePlan,
    })}:${input.environmentConfigurationHash ?? input.configurationHash ?? ""}`,
  );
  return { metadata, scope, templateHash };
}

function buildRuntimeSandboxTemplateKey(
  input: { readonly providerName: string },
  parts: RuntimeSandboxKeyParts,
): string {
  const templateHash = createStableHash(
    `${resolvePackageVersionForTemplateKey(parts.metadata)}:${RUNTIME_SANDBOX_CONTRACT_VERSION}:${parts.templateHash}`,
  ).slice(0, 20);

  return sanitizeRuntimeSandboxKey(
    `eve-sbx-tpl-${input.providerName}-${parts.scope}-${templateHash}`,
  );
}

/**
 * Resolves the eve package version that participates in template keys.
 *
 * Build-time prewarm and deployed runtime must derive the same key, but a
 * bundled runtime cannot resolve the installed package.json and may fall back
 * to a version string the prewarm CLI never saw. The compile metadata's
 * generator version ships inside the artifacts both phases read, so both
 * derive the same key from it.
 */
function resolvePackageVersionForTemplateKey(metadata: CompileMetadata | null): string {
  return metadata?.generator.version ?? resolveInstalledPackageInfo().version;
}

async function loadCompileMetadataForKeys(
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): Promise<CompileMetadata | null> {
  try {
    return await loadCompileMetadata({ compiledArtifactsSource });
  } catch {
    // Key derivation must work from whatever artifacts exist; unreadable
    // metadata degrades to the same fallbacks as absent metadata.
    return null;
  }
}

/**
 * Resolves the partition scope shared by template and session keys.
 *
 * On Vercel the scope is the project id (env var or OIDC token claim),
 * never a deployment-scoped identifier: a key that varies per deployment
 * would discard prewarmed templates and, worse, silently discard session
 * sandbox state on every redeploy. The project id is also the only
 * identifier Vercel exposes at both build-time prewarm and deployed
 * runtime; a build-only identifier (e.g. team id) would leave the
 * prewarmed template "not provisioned" at runtime.
 *
 * Everywhere else the scope falls back to realpath(appRoot), then the
 * compiled-artifacts cache key.
 */
async function resolveRuntimeSandboxScope(input: {
  readonly providerName: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): Promise<string> {
  if (input.providerName === "vercel") {
    const projectId = resolveVercelProjectIdFromEnvironment();
    if (projectId !== undefined) {
      return createStableHash(`vercel-project:${projectId}`).slice(0, 16);
    }
  }

  if (input.compiledArtifactsSource.sandboxScope !== undefined) {
    return input.compiledArtifactsSource.sandboxScope;
  }

  const appRoot = getRuntimeCompiledArtifactsSandboxAppRoot(input.compiledArtifactsSource);
  if (appRoot !== undefined) {
    return createStableHash(await realpath(appRoot)).slice(0, 16);
  }

  return createStableHash(getRuntimeCompiledArtifactsCacheKey(input.compiledArtifactsSource)).slice(
    0,
    16,
  );
}

function resolveRuntimeSandboxTemplateHash(input: {
  readonly nodeId: string;
  readonly sourceId: string;
  readonly templatePlan: Exclude<RuntimeSandboxTemplatePlan, { readonly kind: "none" }>;
}): string {
  // No seed files means empty content, independent of unrelated application source.
  const contentHash = input.templatePlan.contentHash ?? "";

  return createStableHash(
    `prepared:${input.templatePlan.revisionHash}:${contentHash}:${input.nodeId}:${input.sourceId}`,
  );
}

function createStableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeRuntimeSandboxKey(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);
}
