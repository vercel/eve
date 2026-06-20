import { deserializeContext } from "#context/serialize.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import type { RuntimeActionCancellationTarget } from "#execution/runtime-action-cancellation.js";
import { createEveCancelTurnRoutePath } from "#protocol/routes.js";
import { resolveRemoteAgentRequestHeaders } from "#execution/remote-agent-dispatch.js";

/** Cancels delegated child sessions owned by the active logical turn. */
export async function cancelRuntimeActionsStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly targets: readonly RuntimeActionCancellationTarget[];
}): Promise<void> {
  "use step";

  if (input.targets.length === 0) return;
  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);

  await Promise.all(
    input.targets.map(async (target) => {
      if (target.kind === "remote") {
        const definition = bundle.subagentRegistry.subagentsByNodeId.get(target.nodeId)?.definition;
        if (definition?.kind !== "remote") {
          throw new Error(`Missing remote agent cancellation target "${target.nodeId}".`);
        }
        const headers = await resolveRemoteAgentRequestHeaders(definition);
        const response = await fetch(
          new URL(createEveCancelTurnRoutePath(target.sessionId), `${definition.url}/`),
          {
            body: JSON.stringify({ cancelToken: target.cancelToken }),
            headers: { "content-type": "application/json", ...headers },
            method: "POST",
          },
        );
        if (!response.ok && response.status !== 409) {
          throw new Error(`Remote turn cancellation failed with HTTP ${response.status}.`);
        }
        return;
      }

      const runtime = createWorkflowRuntime({
        compiledArtifactsSource: bundle.compiledArtifactsSource,
        nodeId: target.nodeId,
      });
      await runtime.cancelTurn(target.sessionId, target.cancelToken);
    }),
  );
}
