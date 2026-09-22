import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import type { loadContext } from "#context/container.js";
import { createSubagentReceiptIdentity } from "#execution/tools/subagent/receipt-identity.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { JsonObject } from "#shared/json.js";

export interface SubagentTaskProjection {
  readonly identity?: ReturnType<typeof createSubagentReceiptIdentity>;
  readonly metadata: {
    readonly agentId: string;
    readonly kind: "subagent";
    readonly mode: "local" | "remote";
    readonly name: string;
  };
  readonly receipt: { readonly agentId: string };
}

export function projectSubagentTask(input: {
  readonly ctx: ReturnType<typeof loadContext>;
  readonly input: JsonObject;
  readonly name: string;
  readonly nodeId: string;
  readonly taskInput: {
    readonly callId: string;
    readonly parentSessionId: string;
    readonly parentTurnId: string;
  };
}): SubagentTaskProjection {
  const continuation = input.input.agentId;
  if (typeof continuation === "string" && continuation.trim() !== "") {
    return {
      metadata: {
        agentId: continuation,
        kind: "subagent",
        mode: readSubagentTaskMode(input.ctx, input.nodeId),
        name: input.name,
      },
      receipt: { agentId: continuation },
    };
  }
  const identity = createSubagentReceiptIdentity({
    callId: input.taskInput.callId,
    nodeId: input.nodeId,
    parentSessionId: input.taskInput.parentSessionId,
    parentTurnId: input.taskInput.parentTurnId,
    subagentName: input.name,
  });
  return {
    identity,
    metadata: {
      agentId: identity.identity.id,
      kind: "subagent",
      mode: readSubagentTaskMode(input.ctx, input.nodeId),
      name: input.name,
    },
    receipt: { agentId: identity.identity.id },
  };
}

function readSubagentTaskMode(
  ctx: ReturnType<typeof loadContext>,
  nodeId: string,
): "local" | "remote" {
  const dynamic = getDynamicSubagentSelection(ctx, nodeId);
  if (dynamic !== undefined) return dynamic.kind === "remote" ? "remote" : "local";

  const registered = ctx.get(BundleKey)?.subagentRegistry.subagentsByNodeId.get(nodeId);
  return registered?.definition.kind === "remote" ? "remote" : "local";
}
