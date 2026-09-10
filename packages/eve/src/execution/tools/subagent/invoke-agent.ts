import { createHook } from "#compiled/@workflow/core/index.js";

import type {
  RuntimeActionResultHookPayload,
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import {
  readWorkflowToolParentHistory,
  readWorkflowToolRunAdmission,
  readWorkflowToolRunOwner,
  readWorkflowToolRunRef,
} from "#execution/tools/workflow/ask.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { RuntimeSubagentChildResult, RuntimeSubagentResult } from "#shared/action-types.js";
import type { JsonValue } from "#shared/json.js";
import type { JsonObject } from "#shared/json.js";
import { disposeHook } from "#execution/hook-ownership.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import type { AgentInput } from "#tools/workflow-definition.js";
import type { ToolContext } from "#tools/definition.js";
import type { TaskInboundUpdate } from "#tasks/types.js";

export type InternalAgentInput = {
  readonly agentId?: string;
  readonly parentHistory?: readonly import("ai").ModelMessage[];
  readonly message: string;
  readonly outputSchema?: JsonObject;
  readonly target: string;
};

/**
 * Asks the owning session to spawn an agent for a workflow tool run. Spawning
 * needs owner-held material (auth, capabilities, admission, the agent handle
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

export type AgentInvocationEvent =
  | SubagentAuthorizationEventHookPayload
  | SubagentInputRequestHookPayload;

export type AgentInvocationReply =
  | AgentInvocationEvent
  | RuntimeActionResultHookPayload
  | TaskInboundUpdate;

/** Invokes an agent from a workflow tool. */
export async function agent(
  ctx: ToolContext,
  target: string,
  input: AgentInput,
): Promise<JsonValue> {
  readWorkflowToolRunRef(ctx);
  validateAgentInput({ ...input, target });
  return await invokeAgent(ctx, {
    agentId: input.agentId,
    parentHistory: input.inheritHistory === true ? readWorkflowToolParentHistory(ctx) : undefined,
    message: input.message,
    outputSchema: input.outputSchema,
    target,
  });
}

/** Invokes an agent with a framework-selected replay-stable invocation id. */
export async function invokeAgent(
  ctx: ToolContext,
  input: InternalAgentInput,
  options: { readonly invocationId: string; readonly returnResult: true },
): Promise<JsonValue | RuntimeSubagentResult>;
export async function invokeAgent(
  ctx: ToolContext,
  input: InternalAgentInput,
  options?: { readonly invocationId?: string; readonly returnResult?: false },
): Promise<JsonValue>;
export async function invokeAgent(
  ctx: ToolContext,
  input: InternalAgentInput,
  options: { readonly invocationId?: string; readonly returnResult?: boolean } = {},
): Promise<JsonValue | RuntimeSubagentResult> {
  validateAgentInput(input);
  const run = readWorkflowToolRunRef(ctx);
  const owner = readWorkflowToolRunOwner(ctx);
  const admission = readWorkflowToolRunAdmission(ctx);
  if (admission !== undefined) {
    const admitted = await admission;
    if (admitted.status === "rejected") throw new Error(admitted.reason);
  }
  const replies = createHook<AgentInvocationReply>();
  const invocationId = options.invocationId ?? `${ctx.callId}:${replies.token}`;
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
          }
          if (options.returnResult === true && run.execution === "blocking") return result;
          if (result.isError === true) throw result.output;
          return result.output;
        }
        continue;
      }
      if (reply.kind === "subagent-input-request") {
        await resumeHookStep(owner.inbox, {
          kind: "request",
          from: run,
          replyTo:
            reply.childSessionInbox?.sessionId === reply.childSessionId
              ? sessionCommandHookToken(reply.childSessionInbox.sessionId)
              : reply.childContinuationToken,
          request: {
            kind: "input-batch",
            requests: reply.event.requests,
          },
          requestCoordinates: {
            sequence: reply.event.sequence,
            stepIndex: reply.event.stepIndex,
            turnId: reply.event.turnId,
          },
        });
        continue;
      }
      if (reply.kind === "task-update") {
        await resumeHookStep(owner.inbox, {
          kind: "report",
          from: run,
          update: reply.message,
        });
        continue;
      }
      await resumeHookStep(owner.inbox, {
        kind: "request",
        from: run,
        replyTo: replies.token,
        request: { event: reply, kind: "authorization-request" },
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

export function validateAgentInput(
  input: InternalAgentInput | (AgentInput & { target: string }),
): void {
  if ("inheritHistory" in input && input.agentId !== undefined && input.inheritHistory === true) {
    throw new TypeError("agent() cannot combine `agentId` with `inheritHistory`.");
  }
  if (typeof input.target !== "string" || input.target.trim() === "") {
    throw new TypeError("agent() requires a non-empty agent name as its first argument.");
  }
  if (typeof input.message !== "string" || input.message.trim() === "") {
    throw new TypeError("agent() requires a non-empty `message`.");
  }
}
