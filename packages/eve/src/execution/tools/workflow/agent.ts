import { createHook } from "#compiled/@workflow/core/index.js";

import type { RuntimeActionResultHookPayload } from "#channel/types.js";
import { readWorkflowToolRunAgentContext } from "#execution/tools/workflow/ask.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { RuntimeSubagentResult } from "#shared/action-types.js";
import type { JsonValue } from "#shared/json.js";
import type { JsonObject } from "#shared/json.js";
import { disposeHook } from "#execution/hook-ownership.js";
import { renderAgentClosedWithoutResult } from "#tasks/render.js";
import type { AgentInput, AgentOptions } from "#tools/workflow-definition.js";
import type { ToolContext } from "#tools/definition.js";

export type InternalAgentInput = {
  readonly taskId?: string;
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

/**
 * Invokes an agent from a workflow tool and waits for its result. The child
 * reports to the owning session, which forwards only the settled result
 * here; human input goes to the session. Aborting `options.signal` asks the
 * owner to cancel the call's task, and the call rejects with the signal's
 * reason. A resumable body that replied owns no work until it reads again.
 */
export async function agent(
  ctx: ToolContext,
  target: string,
  agentInput: AgentInput,
  options: AgentOptions = {},
): Promise<JsonValue> {
  const input: InternalAgentInput = {
    message: agentInput.message,
    outputSchema: agentInput.outputSchema,
    target,
    taskId: agentInput.taskId,
  };
  const context = readWorkflowToolRunAgentContext(ctx);
  if (context.replied === true) {
    throw new Error(
      `ctx.agent("${target}") was called after ctx.reply(). The generation that replied owns no more work; call ctx.receive() first, or start the agent before replying.`,
    );
  }
  validateAgentInput(input);
  const { from: run, owner } = context;
  options.signal?.throwIfAborted();
  const replies = createHook<RuntimeActionResultHookPayload>();
  // Replay-stable: the hook token is deterministic in the workflow body.
  const invocationId = `${ctx.callId}:${replies.token}`;
  try {
    await resumeHookStep(owner.inbox, {
      kind: "request",
      from: run,
      replyTo: replies.token,
      request: { input, invocationId, kind: "agent-invoke" },
    });

    const iterator = replies[Symbol.asyncIterator]();
    while (true) {
      let next: IteratorResult<RuntimeActionResultHookPayload>;
      try {
        next = await nextAgentReply(iterator, ctx.abortSignal, options.signal);
      } catch (error) {
        if (options.signal?.aborted === true) {
          await resumeHookStep(owner.inbox, {
            kind: "request",
            from: run,
            replyTo: replies.token,
            request: { invocationId, kind: "agent-cancel" },
          });
        }
        throw error;
      }
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
  throw new Error(renderAgentClosedWithoutResult(input.target));
}

/** The next reply, or the reason of whichever signal aborts first. */
async function nextAgentReply(
  iterator: AsyncIterator<RuntimeActionResultHookPayload>,
  ...signals: readonly (AbortSignal | undefined)[]
): Promise<IteratorResult<RuntimeActionResultHookPayload>> {
  const live = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  for (const signal of live) if (signal.aborted) throw signal.reason;
  if (live.length === 0) return await iterator.next();
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const listeners = live.map((signal) => {
    const abort = (): void => rejectAbort?.(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    return () => signal.removeEventListener("abort", abort);
  });
  try {
    return await Promise.race([iterator.next(), aborted]);
  } finally {
    for (const remove of listeners) remove();
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
