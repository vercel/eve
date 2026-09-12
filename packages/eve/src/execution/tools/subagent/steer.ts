import type { ContextReader } from "#context/key.js";
import { AuthKey } from "#context/keys.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import type { HarnessSession } from "#harness/types.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { JsonObject } from "#shared/json.js";
import { createAgentContinuationBundle } from "#subagents/continuation-bundle.js";
import { dispatchToClaimedAgentAddress } from "#subagents/handle-dispatch.js";
import type { TaskOwnedAgentHandle } from "#subagents/handles/store.js";
import { normalizeRequestedOutputSchema } from "#subagents/invocation.js";
import { resolveAgentInvocationAction } from "./invoke-preparation.js";

export async function steerBackgroundAgent(input: {
  readonly ctx: ContextReader;
  readonly handle: Extract<TaskOwnedAgentHandle, { phase: "claimed" }>;
  readonly callId: string;
  readonly input: JsonObject;
  readonly session: HarnessSession;
}): Promise<void> {
  const action = resolveAgentInvocationAction({
    ctx: input.ctx,
    invocationId: input.callId,
    input: {
      agentId: input.handle.identity.id,
      message: typeof input.input.message === "string" ? input.input.message : "",
      outputSchema: normalizeRequestedOutputSchema(input.input.outputSchema),
      target: input.handle.identity.name,
    },
  });
  const dynamic = getDynamicSubagentSelection(input.ctx, input.handle.identity.nodeId);
  const outcome = await dispatchToClaimedAgentAddress({
    action,
    auth: input.ctx.get(AuthKey) ?? null,
    bundle: createAgentContinuationBundle({
      action,
      bundle: input.ctx.require(BundleKey),
      dynamicRemoteAgent: dynamic?.kind === "remote" ? dynamic.remoteAgent : undefined,
    }),
    currentSession: input.session,
    handle: input.handle,
    reply: { kind: "steer" },
  });
  if (outcome.kind === "error") {
    throw new Error(JSON.stringify(outcome.result.output));
  }
}
