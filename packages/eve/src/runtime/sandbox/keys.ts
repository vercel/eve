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
 * that are not captured by source or resource hashes. Version 7 writes static
 * skill seed files to the sandbox user's $HOME/.agents/skills directory.
 */
const RUNTIME_SANDBOX_CONTRACT_VERSION = 7;

/**
 * Input for deriving the stable runtime keys used for one sandbox definition.
 */
interface CreateRuntimeSandboxKeysInput {
  readonly backendName: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId: string;
  readonly sessionId: string;
  readonly sourceId: string;
  readonly templatePlan: RuntimeSandboxTemplatePlan;
}

/**
 * Creates the stable runtime template and session keys for one sandbox
 * definition under the current artifact source and backend.
 *
 * Both keys derive from one {@link RuntimeSandboxKeyParts} value, so the
 * coupling holds by construction: the session key rotates exactly when
 * the template content rotates.
 */
export async function createRuntimeSandboxKeys(input: CreateRuntimeSandboxKeysInput): Promise<{
  readonly sessionKey: string;
  readonly templateKey: string | null;
}> {
  const parts = await deriveRuntimeSandboxKeyParts(input);
  return {
    sessionKey: buildRuntimeSandboxSessionKey(input, parts),
    templateKey: buildRuntimeSandboxTemplateKey(input, parts),
  };
}

/**
 * Creates the stable reusable template key for one sandbox definition,
 * or `null` when the sandbox should start from a fresh backend runtime.
 *
 * The template key factors in the graph `nodeId` so that two
 * runtime agents (root and subagents) do not collide on the same
 * template when they each own a sandbox authored at the same logical
 * path.
 */
export async function createRuntimeSandboxTemplateKey(input: {
  readonly backendName: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId: string;
  readonly sourceId: string;
  readonly templatePlan: RuntimeSandboxTemplatePlan;
}): Promise<string | null> {
  return buildRuntimeSandboxTemplateKey(input, await deriveRuntimeSandboxKeyParts(input));
}

/**
 * The facts both keys derive from, computed once per derivation:
 * compile metadata, the partition scope, and the sandbox definition's
 * version hash (`null` when the sandbox needs no template).
 */
interface RuntimeSandboxKeyParts {
  readonly metadata: CompileMetadata | null;
  readonly scope: string;
  readonly versionHash: string | null;
}

async function deriveRuntimeSandboxKeyParts(input: {
  readonly backendName: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId: string;
  readonly sourceId: string;
  readonly templatePlan: RuntimeSandboxTemplatePlan;
}): Promise<RuntimeSandboxKeyParts> {
  const metadata = await loadCompileMetadataForKeys(input.compiledArtifactsSource);
  const scope = await resolveRuntimeSandboxScope(input);
  const versionHash =
    input.templatePlan.kind === "none"
      ? null
      : resolveRuntimeSandboxVersionHash({
          compiledArtifactsSource: input.compiledArtifactsSource,
          metadata,
          nodeId: input.nodeId,
          sourceId: input.sourceId,
          templatePlan: input.templatePlan,
        });
  return { metadata, scope, versionHash };
}

function buildRuntimeSandboxTemplateKey(
  input: { readonly backendName: string },
  parts: RuntimeSandboxKeyParts,
): string | null {
  if (parts.versionHash === null) {
    return null;
  }

  const templateHash = createStableHash(
    `${resolvePackageVersionForTemplateKey(parts.metadata)}:${RUNTIME_SANDBOX_CONTRACT_VERSION}:${parts.versionHash}`,
  ).slice(0, 20);

  return sanitizeRuntimeSandboxKey(
    `eve-sbx-tpl-${input.backendName}-${parts.scope}-${templateHash}`,
  );
}

/**
 * Builds the session sandbox key for one sandbox definition.
 *
 * Session keys are pinned per durable session: the scope is stable across
 * deployments so a session reattaches to the same sandbox after a redeploy
 * and keeps its `/workspace` state. The key also folds in the sandbox
 * definition's version hash, so changing the sandbox itself (bootstrap
 * source, `revalidationKey`, or workspace seed content) rotates the
 * session sandbox onto the new template — unrelated source changes do not.
 * The eve package version deliberately does not participate: upgrading
 * eve must not discard session sandbox state.
 */
function buildRuntimeSandboxSessionKey(
  input: { readonly backendName: string; readonly nodeId: string; readonly sessionId: string },
  parts: RuntimeSandboxKeyParts,
): string {
  const version = createStableHash(
    `${RUNTIME_SANDBOX_CONTRACT_VERSION}:${parts.versionHash ?? "none"}`,
  ).slice(0, 12);
  const nodeScope = sanitizeRuntimeSandboxKey(input.nodeId);

  return sanitizeRuntimeSandboxKey(
    `eve-sbx-ses-${input.backendName}-${parts.scope}-${version}-${input.sessionId}-${nodeScope}`,
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
  readonly backendName: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): Promise<string> {
  if (input.backendName === "vercel") {
    const projectId = resolveVercelProjectIdFromEnvironment();
    if (projectId !== undefined) {
      return createStableHash(`vercel-project:${projectId}`).slice(0, 16);
    }
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

function resolveRuntimeSandboxVersionHash(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly metadata: CompileMetadata | null;
  readonly nodeId: string;
  readonly sourceId: string;
  readonly templatePlan: Exclude<RuntimeSandboxTemplatePlan, { readonly kind: "none" }>;
}): string {
  const contentHash =
    input.templatePlan.contentHash ??
    resolveSourceGraphHash(input.metadata, input.compiledArtifactsSource);

  if (input.templatePlan.kind === "bootstrap") {
    const revalidationKey = input.templatePlan.revalidationKey ?? "";
    return createStableHash(
      `bootstrap:${revalidationKey}:${input.templatePlan.sourceHash}:${contentHash}:${input.nodeId}:${input.sourceId}`,
    );
  }

  return createStableHash(`workspace-content:${contentHash}:${input.nodeId}:${input.sourceId}`);
}

function resolveSourceGraphHash(
  metadata: CompileMetadata | null,
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): string {
  return (
    metadata?.discovery.sourceGraphHash ??
    getRuntimeCompiledArtifactsCacheKey(compiledArtifactsSource)
  );
}

function createStableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeRuntimeSandboxKey(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);
}
