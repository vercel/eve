import { compiledAgentManifestSchema, type CompiledAgentManifest } from "#compiler/manifest.js";
import { assertCompiledAgentManifestSemantics } from "#compiler/module-binding.js";
import { assertWorkspaceResourceRootSemantics } from "#compiler/workspace-resource-semantics.js";

/** Parses both the structural and relational compiled-manifest contract. */
export function parseCompiledAgentManifest(value: unknown): CompiledAgentManifest {
  const manifest = compiledAgentManifestSchema.parse(value);
  assertSerializedCompiledAgentManifestSemantics(manifest);
  return manifest;
}

/** Validates relational contracts that apply after compiled artifacts are materialized. */
export function assertSerializedCompiledAgentManifestSemantics(
  manifest: CompiledAgentManifest,
): void {
  assertCompiledAgentManifestSemantics(manifest);
  assertWorkspaceResourceRootSemantics(manifest, {
    nodeId: "__root__",
    requireContentHash: true,
  });
  for (const subagent of manifest.subagents) {
    assertWorkspaceResourceRootSemantics(subagent.agent, {
      nodeId: subagent.nodeId,
      requireContentHash: true,
    });
  }
}
