import { sendInboxStep } from "#execution/inbox/send.js";
import type { InboxEnvelope, OwnerInbox } from "#execution/inbox/types.js";

import type {
  RuntimeActionResultHookPayload,
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import {
  readWorkflowToolRunInbox,
  createWorkflowReplyTarget,
  readWorkflowToolRunOwner,
  readWorkflowToolRunRef,
} from "#execution/workflow-tool/ask.js";
import type { RuntimeSubagentChildResult, RuntimeSubagentResult } from "#shared/action-types.js";
import type { JsonValue } from "#shared/json.js";
import type { JsonObject } from "#shared/json.js";
import type { ToolContext } from "#tools/definition.js";
import type { TaskInboundUpdate } from "#tasks/types.js";

export type InternalAgentInput = {
  readonly agentId?: string;
  readonly message: string;
  readonly outputSchema?: JsonObject;
  readonly target: string;
};

export interface AgentInput {
  readonly agentId?: string;
  readonly key: string;
  readonly message: string;
  readonly outputSchema?: JsonObject;
  readonly target: string;
}

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

const AGENT_INVOCATION_IDS = Symbol.for("eve.workflow-tool-run.agent-invocation-ids");

/** Invokes an agent from a task-owned background workflow tool. */
export async function agent(ctx: ToolContext, input: AgentInput): Promise<JsonValue> {
  validateAgentInput(input, true);
  return await invokeAgent(
    ctx,
    {
      agentId: input.agentId,
      message: input.message,
      outputSchema: input.outputSchema,
      target: input.target,
    },
    { invocationId: `${ctx.callId}:${input.key}` },
  );
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
  options: { readonly invocationId: string; readonly returnResult?: false },
): Promise<JsonValue>;
export async function invokeAgent(
  ctx: ToolContext,
  input: InternalAgentInput,
  options: { readonly invocationId: string; readonly returnResult?: boolean },
): Promise<JsonValue | RuntimeSubagentResult> {
  validateAgentInput(input, false);
  const run = readWorkflowToolRunRef(ctx);
  const owner = readWorkflowToolRunOwner(ctx);
  const inbox = readWorkflowToolRunInbox(ctx);
  claimInvocationId(ctx, options.invocationId);
  const replyTo = createWorkflowReplyTarget(ctx, options.invocationId);
  let messageIndex = 0;
  {
    await sendRequest({
      from: run,
      replyTo,
      request: { input, invocationId: options.invocationId, kind: "agent-invoke" },
    });

    while (true) {
      const reply = (await nextAgentReply(inbox, options.invocationId, ctx.abortSignal))
        .payload as AgentInvocationReply;
      if (reply.kind === "runtime-action-result") {
        const result = reply.results.find(
          (candidate): candidate is RuntimeSubagentResult =>
            candidate.kind === "subagent-result" && candidate.callId === options.invocationId,
        );
        if (result !== undefined) {
          if (result.origin === "child") {
            await sendRequest({
              from: run,
              replyTo,
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
        await sendRequest({
          from: run,
          replyTo: { kind: "session", token: reply.childContinuationToken },
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
        await sendReport({
          from: run,
          update: reply.message,
        });
        continue;
      }
      await sendRequest({
        from: run,
        replyTo,
        request: { event: reply, kind: "authorization-request" },
      });
    }
  }

  async function sendRequest(
    payload: import("#execution/workflow-tool/messages.js").WorkflowToolRunRequestMessage,
  ): Promise<void> {
    const kind = payload.request.kind;
    const suffix =
      kind === "agent-invoke"
        ? "invoke"
        : kind === "agent-settled"
          ? "settled"
          : `${kind}:${messageIndex++}`;
    const delivered = await sendInboxStep(owner, {
      eventId: `${options.invocationId}:${suffix}`,
      kind: "tool.request",
      payload,
    });
    if (delivered === "gone")
      throw new Error("The workflow tool owner ended during agent invocation.");
  }

  async function sendReport(
    payload: import("#execution/workflow-tool/messages.js").WorkflowToolRunReport,
  ): Promise<void> {
    await sendInboxStep(owner, {
      eventId: `${options.invocationId}:report:${messageIndex++}`,
      kind: "tool.report",
      payload,
    });
  }
}

async function nextAgentReply(
  inbox: OwnerInbox,
  requestId: string,
  signal: AbortSignal | undefined,
): Promise<InboxEnvelope> {
  return await inbox.response(requestId, signal);
}

export function validateAgentInput(
  input: InternalAgentInput | AgentInput,
  requireKey: boolean,
): void {
  if (
    requireKey &&
    (typeof (input as AgentInput).key !== "string" || (input as AgentInput).key.trim() === "")
  ) {
    throw new TypeError("agent() requires a non-empty `key`.");
  }
  if (typeof input.target !== "string" || input.target.trim() === "") {
    throw new TypeError("agent() requires a non-empty `target`.");
  }
  if (typeof input.message !== "string" || input.message.trim() === "") {
    throw new TypeError("agent() requires a non-empty `message`.");
  }
}

function claimInvocationId(ctx: ToolContext, invocationId: string): void {
  const holder = ctx as ToolContext & { [AGENT_INVOCATION_IDS]?: Set<string> };
  const ids = holder[AGENT_INVOCATION_IDS] ?? new Set<string>();
  if (ids.has(invocationId)) {
    const separator = invocationId.lastIndexOf(":");
    const key = separator < 0 ? invocationId : invocationId.slice(separator + 1);
    throw new TypeError(
      `agent() invocation key "${key}" was already used in this run; keys must be unique per run.`,
    );
  }
  ids.add(invocationId);
  if (holder[AGENT_INVOCATION_IDS] === undefined) {
    Object.defineProperty(holder, AGENT_INVOCATION_IDS, { enumerable: false, value: ids });
  }
}
