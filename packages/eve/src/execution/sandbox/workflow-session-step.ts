import { bindSandboxAbortSignal } from "#execution/sandbox/abort-bound-session.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import type { WorkflowSandboxReferenceData } from "#execution/sandbox/workflow-reference.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { RuntimeSandboxSession, SandboxSession } from "#shared/sandbox-session.js";

export async function openWorkflowSandboxStep(input: {
  readonly abortSignal: AbortSignal;
  readonly reference: WorkflowSandboxReferenceData;
}): Promise<RuntimeSandboxSession> {
  "use step";

  const bundle = await getCompiledRuntimeAgentBundle({
    compiledArtifactsSource: input.reference.compiledArtifactsSource,
    nodeId: input.reference.nodeId,
  });
  const access = await ensureSandboxAccess({
    ...input.reference,
    registry: bundle.graph.root.sandboxRegistry,
  });
  const sandbox = await access.get();
  if (sandbox === null) {
    throw new Error("The sandbox is not available in the current authored runtime context.");
  }
  return bindSandboxAbortSignal(
    withWorkflowSandboxLifecycle({
      access,
      sandbox,
    }),
    input.abortSignal,
  );
}

function withWorkflowSandboxLifecycle(input: {
  readonly access: Awaited<ReturnType<typeof ensureSandboxAccess>>;
  readonly sandbox: SandboxSession;
}): RuntimeSandboxSession {
  return {
    delete() {
      throw new Error("sandbox.delete() is not available inside a defineWorkflowTool() step.");
    },
    id: input.sandbox.id,
    readBinaryFile: (options) => input.sandbox.readBinaryFile(options),
    readFile: (options) => input.sandbox.readFile(options),
    readTextFile: (options) => input.sandbox.readTextFile(options),
    removePath: (options) => input.sandbox.removePath(options),
    resolvePath: (path) => input.sandbox.resolvePath(path),
    run: (options) => input.sandbox.run(options),
    setNetworkPolicy: (policy) => input.sandbox.setNetworkPolicy(policy),
    spawn: (options) => input.sandbox.spawn(options),
    stop: async () => await input.access.stop(),
    writeBinaryFile: (options) => input.sandbox.writeBinaryFile(options),
    writeFile: (options) => input.sandbox.writeFile(options),
    writeTextFile: (options) => input.sandbox.writeTextFile(options),
  };
}
