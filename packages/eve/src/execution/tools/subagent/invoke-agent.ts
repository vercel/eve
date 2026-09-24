import { createHook } from "#compiled/@workflow/core/index.js";

import type { RuntimeActionResultHookPayload } from "#channel/types.js";
import { readWorkflowToolRunOwner, readWorkflowToolRunRef } from "#execution/tools/workflow/ask.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { RuntimeSubagentResult } from "#shared/action-types.js";
import type { JsonValue } from "#shared/json.js";
import type { JsonObject } from "#shared/json.js";
import { disposeHook } from "#execution/hook-ownership.js";
import type { AgentInput } from "#tools/workflow-definition.js";
import type { ToolContext } from "#tools/definition.js";

export type InternalAgentInput = {
  readonly agentId?: string;
  readonly message: string;
  readonly outputSchema?: JsonObject;
  readonly target: string;
};

/**
 * Asks the owning session to start an agent task for a workflow tool body.
 * Starting needs owner-held material (auth, capabilities, sandbox, the task
 * table) that a workflow tool body never has.
 */
export interface AgentInvocationRequest {
  readonly input: InternalAgentInput;
  readonly invocationId: string;
  readonly kind: "agent-invoke";
}

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
    message: input.message,
    outputSchema: input.outputSchema,
    target,
  });
}

/**
 * Invokes an agent with a framework-selected replay-stable invocation id and
 * waits for its result. The child reports to the owning session, which
 * forwards only the settled result here; human input goes to the session.
 */
export async function invokeAgent(
  ctx: ToolContext,
  input: InternalAgentInput,
  options: { readonly invocationId?: string } = {},
): Promise<JsonValue> {
  validateAgentInput(input);
  const run = readWorkflowToolRunRef(ctx);
  const owner = readWorkflowToolRunOwner(ctx);
  const replies = createHook<RuntimeActionResultHookPayload>();
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
      const result = next.value.results.find(
        (candidate): candidate is RuntimeSubagentResult =>
          candidate.kind === "subagent-result" && candidate.callId === invocationId,
      );
      if (result === undefined) continue;
      if (result.isError === true) throw result.output;
      return result.output;
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
  iterator: AsyncIterator<RuntimeActionResultHookPayload>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<RuntimeActionResultHookPayload>> {
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
  if (typeof input.target !== "string" || input.target.trim() === "") {
    throw new TypeError("agent() requires a non-empty agent name as its first argument.");
  }
  if (typeof input.message !== "string" || input.message.trim() === "") {
    throw new TypeError("agent() requires a non-empty `message`.");
  }
  if (
    input.outputSchema !== undefined &&
    (typeof input.outputSchema !== "object" ||
      input.outputSchema === null ||
      Array.isArray(input.outputSchema))
  ) {
    throw new TypeError("agent() `outputSchema` must be a JSON Schema object.");
  }
}
