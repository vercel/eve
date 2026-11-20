import { createConnectionSession } from "#execution/sandbox/session.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { readBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import { loadSandboxPreparedArtifact } from "#runtime/sandbox/prepared-artifacts.js";
import { owningSandboxDefinition } from "#runtime/sandbox/registry.js";
import {
  getSandboxTemplateRebuilder,
  type SandboxTemplateRebuildInput,
  type SandboxTemplateRebuildResult,
} from "#sandbox/template-rebuild.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";

/**
 * Rebuilds the agent's Vercel sandbox template from its latest snapshot, so sessions that start
 * afterwards open from it without a redeploy. Sessions already running keep their own sandbox.
 * Runs in a built deployment, from a schedule, channel or tool.
 */
export async function rebuildSandboxTemplate(
  input: SandboxTemplateRebuildInput,
): Promise<SandboxTemplateRebuildResult> {
  if (readBundledCompiledArtifacts() === null) {
    throw new Error(
      "rebuildSandboxTemplate() runs in a built deployment (`eve build`), where the sandbox template was prepared. " +
        "`eve dev` prepares its own templates lazily and has nothing to rebuild.",
    );
  }
  const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
  const { graph } = await getCompiledRuntimeAgentBundle({ compiledArtifactsSource });
  const owner = owningSandboxDefinition(graph.root.sandboxRegistry.sandbox);
  if (owner.kind !== "independent") {
    throw new Error(
      `Sandbox "${owner.logicalPath}" uses defineParentSandbox(), so the agent has no template of its own to rebuild.`,
    );
  }
  const provider = getSandboxEnvironmentRuntime(owner.environment);
  const artifact = await loadSandboxPreparedArtifact({
    compiledArtifactsSource,
    nodeId: graph.root.nodeId,
    providerName: provider.providerName,
  });
  if (artifact === undefined) {
    throw new SandboxTemplateNotProvisionedError({
      nodeId: graph.root.nodeId,
      providerName: provider.providerName,
    });
  }
  const rebuild = getSandboxTemplateRebuilder(provider.implementation);
  if (rebuild === undefined) {
    throw new Error(
      `The "${provider.providerName}" sandbox provider cannot rebuild its template. Select Vercel Sandbox, directly or through DefaultSandbox.`,
    );
  }
  return await rebuild(artifact, {
    prepare: (connection) => input.prepare(createConnectionSession(connection)),
    revision: input.revision,
  });
}
