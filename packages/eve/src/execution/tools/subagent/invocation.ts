import { createHook } from "#compiled/@workflow/core/index.js";

import type {
  RuntimeActionResultHookPayload,
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import {
  readWorkflowToolRunAdmission,
  readWorkflowToolRunOwner,
  readWorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { JsonValue } from "#shared/json.js";
import type { JsonObject } from "#shared/json.js";
import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";
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

export interface AgentInvocationRequest {
  readonly input: InternalAgentInput;
  readonly invocationId: string;
  readonly kind: "effect";
  readonly name: "agent.invoke";
}

export type AgentInvocationEvent =
  | SubagentAuthorizationEventHookPayload
  | SubagentInputRequestHookPayload;

export type AgentInvocationReply =
  | AgentInvocationEvent
  | RuntimeActionResultHookPayload
  | TaskInboundUpdate;

export const AGENT_INVOCATION_EVENT_EFFECT = "agent.event";
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
  options: { readonly invocationId: string },
): Promise<JsonValue> {
  validateAgentInput(input, false);
  const run = readWorkflowToolRunRef(ctx);
  const owner = readWorkflowToolRunOwner(ctx);
  const admission = readWorkflowToolRunAdmission(ctx);
  if (run.execution !== "background") {
    throw new Error("agent() is only available inside a background workflow tool.");
  }
  claimInvocationId(ctx, options.invocationId);
  const replies = createHook<AgentInvocationReply>();
  let ownsReplies = false;
  let eventIndex = 0;
  try {
    await claimHookOwnership(replies);
    ownsReplies = true;
    if (admission !== undefined) {
      const admitted = await admission;
      if (admitted.status === "rejected") throw new Error(admitted.reason);
    }
    await resumeHookStep(owner.request, {
      from: run,
      replyTo: replies.token,
      request: {
        input,
        invocationId: options.invocationId,
        kind: "effect",
        name: "agent.invoke",
      },
    });

    const iterator = replies[Symbol.asyncIterator]();
    while (true) {
      const next = await nextAgentReply(iterator, ctx.abortSignal);
      if (next.done) break;
      const reply = next.value;
      if (reply.kind === "runtime-action-result") {
        const result = reply.results.find(
          (candidate) =>
            candidate.kind === "subagent-result" && candidate.callId === options.invocationId,
        );
        if (result !== undefined) {
          await resumeHookStep(owner.request, {
            from: run,
            replyTo: replies.token,
            request: {
              input: JSON.parse(JSON.stringify(result)) as JsonValue,
              invocationId: `${options.invocationId}:settled`,
              kind: "effect",
              name: "agent.settled",
            },
          });
          if (result.isError === true) throw result.output;
          return result.output;
        }
        continue;
      }
      if (reply.kind === "subagent-input-request") {
        await resumeHookStep(owner.request, {
          from: run,
          replyTo: reply.childContinuationToken,
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
        await resumeHookStep(owner.report, {
          from: run,
          update: reply.message,
        });
        continue;
      }
      await resumeHookStep(owner.request, {
        from: run,
        replyTo: replies.token,
        request: {
          input: toJsonValue(reply),
          invocationId: `${options.invocationId}:event:${eventIndex++}`,
          kind: "effect",
          name: AGENT_INVOCATION_EVENT_EFFECT,
        },
      });
    }
  } finally {
    if (ownsReplies) {
      try {
        await disposeHook(replies);
      } catch {
        // A result or invocation error is authoritative; reply-hook cleanup is best effort.
      }
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

function toJsonValue(value: AgentInvocationEvent): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function isAgentInvocationEvent(value: unknown): value is AgentInvocationEvent {
  if (typeof value !== "object" || value === null) return false;
  const kind = Reflect.get(value, "kind");
  return kind === "subagent-authorization-event" || kind === "subagent-input-request";
}

export function isAgentInvocationRequest(value: unknown): value is AgentInvocationRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as {
    input?: unknown;
    invocationId?: unknown;
    kind?: unknown;
    name?: unknown;
  };
  if (
    request.kind !== "effect" ||
    request.name !== "agent.invoke" ||
    typeof request.invocationId !== "string" ||
    typeof request.input !== "object" ||
    request.input === null
  ) {
    return false;
  }
  return (
    typeof Reflect.get(request.input, "target") === "string" &&
    typeof Reflect.get(request.input, "message") === "string"
  );
}

function claimInvocationId(ctx: ToolContext, invocationId: string): void {
  const holder = ctx as ToolContext & { [AGENT_INVOCATION_IDS]?: Set<string> };
  const ids = holder[AGENT_INVOCATION_IDS] ?? new Set<string>();
  if (ids.has(invocationId)) {
    const separator = invocationId.lastIndexOf(":");
    const key = separator < 0 ? invocationId : invocationId.slice(separator + 1);
    throw {
      code: "DUPLICATE_AGENT_INVOCATION_KEY",
      message: `agent() invocation key "${key}" was already used in this run; keys must be unique per run.`,
    };
  }
  ids.add(invocationId);
  if (holder[AGENT_INVOCATION_IDS] === undefined) {
    Object.defineProperty(holder, AGENT_INVOCATION_IDS, { enumerable: false, value: ids });
  }
}

export function isAgentInvocationEventEffect(value: {
  readonly input: unknown;
  readonly name: string;
}): value is { readonly input: AgentInvocationEvent; readonly name: "agent.event" } {
  return value.name === AGENT_INVOCATION_EVENT_EFFECT && isAgentInvocationEvent(value.input);
}
