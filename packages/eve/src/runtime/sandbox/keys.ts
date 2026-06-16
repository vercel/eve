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
import type { RuntimeSandboxTemplatePlan } from "#runtime/sandbox/template-plan.js";

// v6: the local backend's default engine moved from just-bash to
// Docker; bumping invalidates just-bash-era template state.
const RUNTIME_SANDBOX_CONTRACT_VERSION = 6;

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
 */
export async function createRuntimeSandboxKeys(input: CreateRuntimeSandboxKeysInput): Promise<{
  readonly sessionKey: string;
  readonly templateKey: string | null;
}> {
  return {
    sessionKey: await createRuntimeSandboxSessionKey(input),
    templateKey: await createRuntimeSandboxTemplateKey(input),
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
  if (input.templatePlan.kind === "none") {
    return null;
  }

  const metadata = await loadCompileMetadataForKeys(input.compiledArtifactsSource);
  const scope = await resolveRuntimeSandboxScope({
    backendName: input.backendName,
    compiledArtifactsSource: input.compiledArtifactsSource,
    scopeKind: input.templatePlan.kind === "source-graph" ? "deployment" : "stable",
  });
  const versionHash = resolveRuntimeSandboxVersionHash({
    compiledArtifactsSource: input.compiledArtifactsSource,
    metadata,
    nodeId: input.nodeId,
    sourceId: input.sourceId,
    templatePlan: input.templatePlan,
  });
  const templateHash = createStableHash(
    `${resolvePackageVersionForTemplateKey(metadata)}:${RUNTIME_SANDBOX_CONTRACT_VERSION}:${versionHash}`,
  ).slice(0, 20);

  return sanitizeRuntimeSandboxKey(`eve-sbx-tpl-${input.backendName}-${scope}-${templateHash}`);
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

async function createRuntimeSandboxSessionKey(input: {
  readonly backendName: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId: string;
  readonly sessionId: string;
}): Promise<string> {
  const scope = await resolveRuntimeSandboxScope({
    backendName: input.backendName,
    compiledArtifactsSource: input.compiledArtifactsSource,
    scopeKind: "deployment",
  });
  const nodeScope = sanitizeRuntimeSandboxKey(input.nodeId);

  return sanitizeRuntimeSandboxKey(
    `eve-sbx-ses-${input.backendName}-${scope}-${input.sessionId}-${nodeScope}`,
  );
}

/**
 * Resolves the partition key used in Vercel Sandbox template/session names.
 *
 * Source-graph templates use deployment id for Vercel. Stable templates
 * prefer the Vercel project id, then fall back through deployment id,
 * realpath(appRoot), and the compiled-artifacts cache key.
 *
 * Stable scopes key on `VERCEL_PROJECT_ID` alone because it is the only
 * identifier Vercel exposes at both build-time prewarm and deployed runtime;
 * any build-only identifier (e.g. team id) would leave the prewarmed template
 * "not provisioned" at runtime.
 */
async function resolveRuntimeSandboxScope(input: {
  readonly backendName: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly scopeKind: "deployment" | "stable";
}): Promise<string> {
  if (input.backendName === "vercel") {
    if (input.scopeKind === "stable") {
      const projectScope = resolveVercelProjectScope();
      if (projectScope !== undefined) {
        return createStableHash(projectScope).slice(0, 16);
      }
    }

    const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim();
    if (deploymentId !== undefined && deploymentId.length > 0) {
      return createStableHash(deploymentId).slice(0, 16);
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
  if (input.templatePlan.kind === "bootstrap") {
    const contentHash =
      input.templatePlan.contentHash ??
      resolveSourceGraphHash(input.metadata, input.compiledArtifactsSource);
    const revalidationKey = input.templatePlan.revalidationKey ?? "";
    return createStableHash(
      `bootstrap:${revalidationKey}:${input.templatePlan.sourceHash}:${contentHash}:${input.nodeId}:${input.sourceId}`,
    );
  }

  if (input.templatePlan.kind === "workspace-content") {
    const contentHash =
      input.templatePlan.contentHash ??
      resolveSourceGraphHash(input.metadata, input.compiledArtifactsSource);
    return createStableHash(`workspace-content:${contentHash}:${input.nodeId}:${input.sourceId}`);
  }

  const sourceGraphHash = resolveSourceGraphHash(input.metadata, input.compiledArtifactsSource);
  return createStableHash(`source-graph:${sourceGraphHash}:${input.nodeId}:${input.sourceId}`);
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

function resolveVercelProjectScope(): string | undefined {
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();
  if (projectId === undefined || projectId.length === 0) {
    return undefined;
  }

  return `vercel-project:${projectId}`;
}

function createStableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeRuntimeSandboxKey(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);
}
