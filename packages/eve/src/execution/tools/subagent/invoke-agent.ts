import { createHook } from "#compiled/@workflow/core/index.js";

import type { RuntimeActionResultHookPayload } from "#channel/types.js";
import {
  forwardAgentSessionRequest,
  type AgentSessionRequest,
} from "#execution/agent-sessions/requests.js";
import { readWorkflowToolRunOwner, readWorkflowToolRunRef } from "#execution/tools/workflow/ask.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { RuntimeSubagentChildResult, RuntimeSubagentResult } from "#shared/action-types.js";
import type { JsonValue } from "#shared/json.js";
import type { JsonObject } from "#shared/json.js";
import { disposeHook } from "#execution/hook-ownership.js";
import type { ToolContext } from "#tools/definition.js";

export type InternalAgentInput = {
  readonly agentId?: string;
  readonly message: string;
  readonly outputSchema?: JsonObject;
  readonly target: string;
};

/**
 * Asks the owning session to spawn an agent for a workflow tool run. Spawning
 * needs owner-held material (auth, capabilities, the agent handle
 * store) that a workflow tool body never has.
 */
export interface AgentInvocationRequest {
  readonly input: InternalAgentInput;
  readonly invocationId: string;
  readonly kind: "agent-invoke";
}

/**
 * Tells the owning session that an owner-spawned agent replied to the run, so
 * the owner can release the handle it reserved for `agent-invoke`.
 */
export interface AgentSettlementRequest {
  readonly kind: "agent-settled";
  readonly result: RuntimeSubagentChildResult;
}

export type AgentInvocationReply =
  | AgentSessionRequest
  | RuntimeActionResultHookPayload
  | { readonly kind: "agent-settled"; readonly callId: string };

/**
 * Invokes an agent for one of the model's agent tools, whose tool call id is
 * the invocation id. The owning session spawns the child and leases its handle.
 */
export async function invokeAgent(
  ctx: ToolContext,
  input: InternalAgentInput,
  options: { readonly invocationId: string },
): Promise<JsonValue> {
  validateAgentInput(input);
  const run = readWorkflowToolRunRef(ctx);
  const owner = readWorkflowToolRunOwner(ctx);
  const replies = createHook<AgentInvocationReply>();
  const { invocationId } = options;
  try {
    await resumeHookStep(owner.inbox, {
      kind: "request",
      from: run,
      replyTo: replies.token,
      request: { input, invocationId, kind: "agent-invoke" },
    });

    const iterator = replies[Symbol.asyncIterator]();
    while (true) {
      const next = await nextAgentReply(iterator, ctx.abortSignal);
      if (next.done) break;
      const reply = next.value;
      if (reply.kind === "runtime-action-result") {
        const result = reply.results.find(
          (candidate): candidate is RuntimeSubagentResult =>
            candidate.kind === "subagent-result" && candidate.callId === invocationId,
        );
        if (result !== undefined) {
          if (result.origin === "child") {
            await resumeHookStep(owner.inbox, {
              kind: "request",
              from: run,
              replyTo: replies.token,
              request: { kind: "agent-settled", result },
            });
            // The enclosing workflow cannot finish before its owner applies settlement.
            for (;;) {
              const acknowledgement = await nextAgentReply(iterator, ctx.abortSignal);
              if (acknowledgement.done)
                throw new Error(`Agent "${input.target}" closed before settlement.`);
              if (
                acknowledgement.value.kind === "agent-settled" &&
                acknowledgement.value.callId === invocationId
              )
                break;
            }
          }
          if (result.isError === true) throw result.output;
          return result.output;
        }
        continue;
      }
      if (reply.kind === "agent-settled") continue;
      await forwardAgentSessionRequest({
        from: run,
        inbox: owner.inbox,
        replyTo: replies.token,
        request: reply,
      });
    }
  } finally {
    try {
      await disposeHook(replies);
    } catch {
      // A result or invocation error is authoritative; reply-hook cleanup is best effort.
    }
  }
  throw new Error(`Agent "${input.target}" closed without a result.`);
}

async function nextAgentReply(
  iterator: AsyncIterator<AgentInvocationReply>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<AgentInvocationReply>> {
  if (signal === undefined) return await iterator.next();
  if (signal.aborted) throw signal.reason;
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (): void => rejectAbort?.(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([iterator.next(), aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function validateAgentInput(input: InternalAgentInput): void {
  if (typeof input.message !== "string" || input.message.trim() === "") {
    throw new TypeError(`Agent tool "${input.target}" requires a non-empty \`message\`.`);
  }
  if (
    input.outputSchema !== undefined &&
    (typeof input.outputSchema !== "object" ||
      input.outputSchema === null ||
      Array.isArray(input.outputSchema))
  ) {
    throw new TypeError(
      `Agent tool "${input.target}" \`outputSchema\` must be a JSON Schema object.`,
    );
  }
}
