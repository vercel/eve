import type { loadContext } from "#context/container.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import { createSubagentReceiptIdentity } from "#execution/tools/subagent/receipt-identity.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { JsonObject } from "#shared/json.js";

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
}) {
  const dynamic = getDynamicSubagentSelection(input.ctx, input.nodeId);
  const registered = input.ctx.get(BundleKey)?.subagentRegistry.subagentsByNodeId.get(input.nodeId);
  const mode: "remote" | "local" =
    (dynamic?.kind ?? registered?.definition.kind) === "remote" ? "remote" : "local";
  const continuation = input.input.agentId;
  const identity =
    typeof continuation === "string" && continuation.trim() !== ""
      ? undefined
      : createSubagentReceiptIdentity({
          ...input.taskInput,
          nodeId: input.nodeId,
          subagentName: input.name,
        });
  const agentId = identity?.identity.id ?? String(continuation);
  return {
    identity,
    metadata: { agentId, kind: "subagent" as const, mode, name: input.name },
    receipt: { agentId },
  };
}
