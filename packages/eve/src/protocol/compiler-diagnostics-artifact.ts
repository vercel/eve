import { z } from "#compiled/zod/index.js";

import type { CompiledAgentManifest, CompiledAgentResources } from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { collectCompiledModuleScopes } from "#compiler/module-scope.js";
import {
  CHANNEL_ROUTE_SHADOWED_DIAGNOSTIC_CODE,
  compilerDiagnosticSchema,
  compilerDiagnosticsSummarySchema,
  summarizeCompilerDiagnostics,
  type CompilerDiagnostic,
  type CompilerDiagnosticsSummary,
} from "#shared/compiler-diagnostics.js";

/** Stable diagnostics artifact kind emitted by the compiler. */
export const COMPILER_DIAGNOSTICS_ARTIFACT_KIND = "eve-compiler-diagnostics";

/** Current diagnostics artifact schema version. */
export const COMPILER_DIAGNOSTICS_ARTIFACT_VERSION = 3;

/** Machine-readable diagnostics artifact written beside a compiled manifest. */
export interface CompilerDiagnosticsArtifact {
  readonly diagnostics: CompilerDiagnostic[];
  readonly kind: typeof COMPILER_DIAGNOSTICS_ARTIFACT_KIND;
  readonly summary: CompilerDiagnosticsSummary;
  readonly version: typeof COMPILER_DIAGNOSTICS_ARTIFACT_VERSION;
}

/** Runtime-safe structural schema for the compiler diagnostics artifact. */
export const compilerDiagnosticsArtifactSchema: z.ZodType<CompilerDiagnosticsArtifact> = z
  .object({
    diagnostics: z.array(compilerDiagnosticSchema),
    kind: z.literal(COMPILER_DIAGNOSTICS_ARTIFACT_KIND),
    summary: compilerDiagnosticsSummarySchema,
    version: z.literal(COMPILER_DIAGNOSTICS_ARTIFACT_VERSION),
  })
  .strict()
  .superRefine((artifact, context) => {
    const summary = summarizeCompilerDiagnostics(artifact.diagnostics);
    if (
      summary.errors !== artifact.summary.errors ||
      summary.warnings !== artifact.summary.warnings
    ) {
      context.addIssue({ code: "custom", message: "Diagnostics summary does not match entries." });
    }
  });

/** Creates a structurally valid diagnostics artifact from compiler output. */
export function createCompilerDiagnosticsArtifact(
  diagnostics: readonly CompilerDiagnostic[],
): CompilerDiagnosticsArtifact {
  return compilerDiagnosticsArtifactSchema.parse({
    diagnostics: [...diagnostics],
    kind: COMPILER_DIAGNOSTICS_ARTIFACT_KIND,
    summary: summarizeCompilerDiagnostics(diagnostics),
    version: COMPILER_DIAGNOSTICS_ARTIFACT_VERSION,
  });
}

/** Validates relationships shared by disk and bundled diagnostics transports. */
export function validateCompilerDiagnosticsArtifactSemantics(input: {
  readonly artifact: CompilerDiagnosticsArtifact;
  readonly manifest: CompiledAgentManifest;
}): readonly string[] {
  const issues: string[] = [];
  const backingKinds = collectBindingBackingKinds(input.manifest);

  for (const diagnostic of input.artifact.diagnostics) {
    validateProgrammaticLocator({
      issues,
      label: `diagnostic "${diagnostic.code}"`,
      locator: diagnostic,
      backingKinds,
    });
    for (const related of diagnostic.related ?? []) {
      validateProgrammaticLocator({
        issues,
        label: `related locator "${related.label}" on diagnostic "${diagnostic.code}"`,
        locator: related,
        backingKinds,
      });
    }
  }

  for (const node of [
    { nodeId: "__root__", resources: input.manifest },
    ...input.manifest.subagents.map((subagent) => ({
      nodeId: subagent.nodeId,
      resources: subagent.agent,
    })),
  ]) {
    if (
      input.artifact.summary.errors !== node.resources.diagnosticsSummary.errors ||
      input.artifact.summary.warnings !== node.resources.diagnosticsSummary.warnings
    ) {
      issues.push(
        `diagnostics summary does not match diagnosticsSummary for compiled node "${node.nodeId}".`,
      );
    }
  }

  const unmatchedShadowedRoutes = collectShadowedRoutes(input.manifest);
  for (const diagnostic of input.artifact.diagnostics) {
    if (diagnostic.code !== CHANNEL_ROUTE_SHADOWED_DIAGNOSTIC_CODE) continue;

    const issue = validateShadowedRouteDiagnostic(diagnostic);
    if (issue !== undefined) {
      issues.push(issue);
      continue;
    }

    const relatedWinner = diagnostic.related![0]!;
    const matchIndex = unmatchedShadowedRoutes.findIndex(
      (route) =>
        route.nodeId === diagnostic.nodeId &&
        route.method === diagnostic.channelRoute!.method &&
        route.pathPattern === diagnostic.channelRoute!.pathPattern &&
        route.loserSourceId === diagnostic.sourceId &&
        route.loserLogicalPath === diagnostic.logicalPath &&
        route.nodeId === relatedWinner.nodeId &&
        route.winnerSourceId === relatedWinner.sourceId &&
        route.winnerLogicalPath === relatedWinner.logicalPath,
    );
    if (matchIndex === -1) {
      issues.push(
        `diagnostic ${formatShadowedRouteDiagnostic(diagnostic)} has no exact channelRoutes.shadowed record.`,
      );
      continue;
    }

    unmatchedShadowedRoutes.splice(matchIndex, 1);
  }

  for (const route of unmatchedShadowedRoutes) {
    issues.push(
      `channelRoutes.shadowed record on node "${route.nodeId}" for ${route.method} ${route.pathPattern} from "${route.loserLogicalPath}" to "${route.winnerLogicalPath}" has no exact ${CHANNEL_ROUTE_SHADOWED_DIAGNOSTIC_CODE} diagnostic.`,
    );
  }

  return issues;
}

function collectBindingBackingKinds(
  manifest: CompiledAgentManifest,
): ReadonlyMap<
  string,
  ReadonlyMap<
    string,
    readonly (
      | { readonly kind: "filesystem"; readonly sourcePath: string }
      | { readonly kind: "programmatic" }
    )[]
  >
> {
  const mutable = new Map<
    string,
    Map<
      string,
      Array<
        | { readonly kind: "filesystem"; readonly sourcePath: string }
        | { readonly kind: "programmatic" }
      >
    >
  >();
  for (const scope of collectCompiledModuleScopes(manifest)) {
    const bySourceId = mutable.get(scope.nodeId) ?? new Map();
    for (const [sourceId, binding] of Object.entries(scope.bindings)) {
      const backings = bySourceId.get(sourceId) ?? [];
      backings.push(
        binding.backing.kind === "filesystem"
          ? { kind: "filesystem", sourcePath: binding.backing.sourcePath }
          : { kind: "programmatic" },
      );
      bySourceId.set(sourceId, backings);
    }
    mutable.set(scope.nodeId, bySourceId);
  }
  return mutable;
}

function validateProgrammaticLocator(input: {
  readonly backingKinds: ReturnType<typeof collectBindingBackingKinds>;
  readonly issues: string[];
  readonly label: string;
  readonly locator: {
    readonly nodeId: string;
    readonly sourceId?: string;
    readonly sourcePath?: string;
  };
}): void {
  if (input.locator.sourcePath === undefined || input.locator.sourceId === undefined) return;

  const backings = input.backingKinds.get(input.locator.nodeId)?.get(input.locator.sourceId) ?? [];
  const matchesFilesystemBacking = backings.some(
    (backing) => backing.kind === "filesystem" && backing.sourcePath === input.locator.sourcePath,
  );
  if (!matchesFilesystemBacking && backings.some((backing) => backing.kind === "programmatic")) {
    input.issues.push(
      `${input.label} fabricates physical sourcePath "${input.locator.sourcePath}" for programmatic source "${input.locator.sourceId}" on node "${input.locator.nodeId}".`,
    );
  }
}

/** Throws when diagnostics and the compiled manifest disagree. */
export function assertCompilerDiagnosticsArtifactSemantics(input: {
  readonly artifact: CompilerDiagnosticsArtifact;
  readonly manifest: CompiledAgentManifest;
}): void {
  const issues = validateCompilerDiagnosticsArtifactSemantics(input);
  if (issues.length > 0) {
    throw new Error(`Invalid compiler diagnostics artifact:\n- ${issues.join("\n- ")}`);
  }
}

interface ShadowedRouteRelationship {
  readonly loserLogicalPath: string;
  readonly loserSourceId: string;
  readonly method: string;
  readonly nodeId: string;
  readonly pathPattern: string;
  readonly winnerLogicalPath: string;
  readonly winnerSourceId: string;
}

function collectShadowedRoutes(manifest: CompiledAgentManifest): ShadowedRouteRelationship[] {
  return [
    { nodeId: ROOT_COMPILED_AGENT_NODE_ID, resources: manifest },
    ...manifest.subagents.map((subagent) => ({
      nodeId: subagent.nodeId,
      resources: subagent.agent,
    })),
  ].flatMap(({ nodeId, resources }) => collectNodeShadowedRoutes(nodeId, resources));
}

function collectNodeShadowedRoutes(
  nodeId: string,
  resources: CompiledAgentResources,
): ShadowedRouteRelationship[] {
  return resources.channelRoutes.shadowed.map((record) => {
    const winner = resources.channelRoutes.effective.find(
      (route) => route.sourceId === record.winningSourceId,
    );

    return {
      loserLogicalPath: record.loser.route.logicalPath,
      loserSourceId: record.loser.route.sourceId,
      method: record.method,
      nodeId,
      pathPattern: record.pathPattern,
      winnerLogicalPath: winner?.logicalPath ?? "<missing winner>",
      winnerSourceId: record.winningSourceId,
    };
  });
}

function validateShadowedRouteDiagnostic(diagnostic: CompilerDiagnostic): string | undefined {
  if (diagnostic.severity !== "warning") {
    return `${CHANNEL_ROUTE_SHADOWED_DIAGNOSTIC_CODE} must have warning severity.`;
  }
  if (diagnostic.sourceId === undefined || diagnostic.logicalPath === undefined) {
    return `${CHANNEL_ROUTE_SHADOWED_DIAGNOSTIC_CODE} requires loser sourceId and logicalPath.`;
  }
  if (diagnostic.channelRoute === undefined) {
    return `${CHANNEL_ROUTE_SHADOWED_DIAGNOSTIC_CODE} requires a structured channelRoute identity.`;
  }
  if (
    diagnostic.related?.length !== 1 ||
    diagnostic.related[0]?.label !== "winner" ||
    diagnostic.related[0].sourceId === undefined ||
    diagnostic.related[0].logicalPath === undefined
  ) {
    return `${CHANNEL_ROUTE_SHADOWED_DIAGNOSTIC_CODE} requires exactly one winner with sourceId and logicalPath.`;
  }

  return undefined;
}

function formatShadowedRouteDiagnostic(diagnostic: CompilerDiagnostic): string {
  const route = diagnostic.channelRoute;
  return route === undefined
    ? `on node "${diagnostic.nodeId}" from "${diagnostic.logicalPath ?? diagnostic.sourceId ?? "unknown"}"`
    : `on node "${diagnostic.nodeId}" for ${route.method} ${route.pathPattern} from "${diagnostic.logicalPath ?? diagnostic.sourceId ?? "unknown"}"`;
}
