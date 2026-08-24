import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { collectCompiledModuleScopes } from "#compiler/module-scope.js";
import type { CompileMetadata } from "#protocol/compile-metadata.js";
import {
  validateCompilerDiagnosticsArtifactSemantics,
  type CompilerDiagnosticsArtifact,
} from "#protocol/compiler-diagnostics-artifact.js";
import { readCompiledModuleMapIdentity } from "#protocol/compiled-module-map-identity.js";

/** Validates cross-artifact relationships that structural schemas cannot express. */
export function validateCompiledArtifactSetSemantics(input: {
  readonly diagnostics: CompilerDiagnosticsArtifact;
  readonly manifest: CompiledAgentManifest;
  readonly metadata: CompileMetadata;
  readonly moduleMap: CompiledModuleMap;
}): readonly string[] {
  const issues = [
    ...validateCompilerDiagnosticsArtifactSemantics({
      artifact: input.diagnostics,
      manifest: input.manifest,
    }),
    ...validateCompiledArtifactMetadataSemantics({
      diagnostics: input.diagnostics,
      metadata: input.metadata,
    }),
  ];

  const moduleMapIdentity = readCompiledModuleMapIdentity(input.moduleMap);
  if (moduleMapIdentity === undefined) {
    issues.push("compiled module map is missing its compiler-owned content identity.");
  } else if (moduleMapIdentity !== input.metadata.compile.moduleMap.identitySha256) {
    issues.push(
      `compiled module map identity mismatch: expected "${input.metadata.compile.moduleMap.identitySha256}", received "${moduleMapIdentity}".`,
    );
  }

  const expectedScopes = collectExpectedModuleScopes(input.manifest);
  const actualNodeIds = Object.keys(input.moduleMap.nodes);
  for (const expected of expectedScopes) {
    const actual = input.moduleMap.nodes[expected.nodeId];
    if (actual === undefined) {
      issues.push(`compiled module map is missing node "${expected.nodeId}".`);
      continue;
    }
    compareKeys({
      actual: Object.keys(actual.modules),
      expected: expected.sourceIds,
      issues,
      label: `compiled module map node "${expected.nodeId}"`,
    });
  }

  const expectedNodeIds = new Set(expectedScopes.map((scope) => scope.nodeId));
  for (const nodeId of actualNodeIds) {
    if (!expectedNodeIds.has(nodeId)) {
      issues.push(`compiled module map has unexpected node "${nodeId}".`);
    }
  }

  return issues;
}

/** Validates metadata state before any module map is loaded or hydrated. */
export function validateCompiledArtifactMetadataSemantics(input: {
  readonly diagnostics: CompilerDiagnosticsArtifact;
  readonly metadata: CompileMetadata;
}): readonly string[] {
  const issues: string[] = [];
  if (input.metadata.status !== "ready") {
    issues.push(`compile metadata status must be "ready", received "${input.metadata.status}".`);
  }
  if (input.metadata.status === "ready" && input.diagnostics.summary.errors !== 0) {
    issues.push(
      `compile metadata status "ready" requires zero compiler errors, received ${input.diagnostics.summary.errors}.`,
    );
  }
  if (
    input.metadata.discovery.summary.errors !== input.diagnostics.summary.errors ||
    input.metadata.discovery.summary.warnings !== input.diagnostics.summary.warnings
  ) {
    issues.push("compile metadata diagnostics summary does not match the diagnostics artifact.");
  }
  return issues;
}

/** Throws when any artifact in one compiled snapshot disagrees with the others. */
export function assertCompiledArtifactSetSemantics(input: {
  readonly diagnostics: CompilerDiagnosticsArtifact;
  readonly manifest: CompiledAgentManifest;
  readonly metadata: CompileMetadata;
  readonly moduleMap: CompiledModuleMap;
}): void {
  const issues = validateCompiledArtifactSetSemantics(input);
  if (issues.length > 0) {
    throw new Error(`Invalid compiled artifact set:\n- ${issues.join("\n- ")}`);
  }
}

function collectExpectedModuleScopes(manifest: CompiledAgentManifest): Array<{
  readonly nodeId: string;
  readonly sourceIds: readonly string[];
}> {
  return collectCompiledModuleScopes(manifest).map((scope) => ({
    nodeId: scope.nodeId,
    sourceIds: [...new Set(scope.refs.map((ref) => ref.sourceId))],
  }));
}

function compareKeys(input: {
  readonly actual: readonly string[];
  readonly expected: readonly string[];
  readonly issues: string[];
  readonly label: string;
}): void {
  const actual = new Set(input.actual);
  const expected = new Set(input.expected);

  for (const sourceId of expected) {
    if (!actual.has(sourceId)) {
      input.issues.push(`${input.label} is missing module "${sourceId}".`);
    }
  }
  for (const sourceId of actual) {
    if (!expected.has(sourceId)) {
      input.issues.push(`${input.label} has unexpected module "${sourceId}".`);
    }
  }
}
