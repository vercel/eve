import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import type { WorkflowToolRunContext } from "#execution/tools/workflow/ask.js";
import { requestWorkflowSandbox } from "#execution/sandbox/workflow-request.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { SandboxAccess } from "#sandbox/state.js";

export function createWorkflowSandboxAccess(input: {
  readonly abortSignal: AbortSignal;
  readonly run?: WorkflowToolRunContext;
}): SandboxAccess {
  let access: Promise<SandboxAccess> | undefined;
  async function open(): Promise<SandboxAccess> {
    if (input.run === undefined) {
      throw Object.assign(
        new Error(
          'ctx.getSandbox() is unavailable inside a "use step" function. Pass the workflow context directly to this step.',
        ),
        { fatal: true },
      );
    }
    const reference = await requestWorkflowSandbox({ ...input, run: input.run });
    const bundle = await getCompiledRuntimeAgentBundle({
      compiledArtifactsSource: reference.compiledArtifactsSource,
      nodeId: reference.nodeId,
    });
    return ensureSandboxAccess({
      ...reference,
      ownsSandbox: false,
      registry: bundle.graph.root.sandboxRegistry,
    });
  }

  return {
    async get() {
      return (await (access ??= open())).get();
    },
    async captureState() {
      return access === undefined ? { session: null } : (await access).captureState();
    },
    async delete() {
      throw new Error("sandbox.delete() is not available inside a defineWorkflowTool() step.");
    },
    async stop() {
      throw new Error(
        "sandbox.stop() is unavailable inside a workflow step; the session owns its lifecycle.",
      );
    },
  };
}
