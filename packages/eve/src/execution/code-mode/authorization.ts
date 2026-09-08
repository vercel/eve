import { createHook } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, SubagentAuthorizationEvent } from "#channel/types.js";
import {
  matchAuthorizationCallbacks,
  type MatchedAuthorizationCallback,
} from "#execution/authorization-callback-match.js";
import {
  executeCodeModeToolStep,
  type CodeModeToolCall,
  type CodeModeToolOutcome,
} from "#execution/code-mode/program-step.js";
import type { CodeModeCallResolution } from "#execution/code-mode/schema.js";
import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";
import { readWorkflowToolRunOwner, readWorkflowToolRunRef } from "#execution/tools/workflow/ask.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import {
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
} from "#protocol/message.js";
import { toErrorMessage } from "#shared/errors.js";
import type { ToolContext } from "#tools/definition.js";

type CodeModeToolContext = Pick<ToolContext, "abortSignal" | "callId" | "toolName">;

/** Owns the callback hook until this nested tool call completes or fails. */
export async function executeCodeModeTool(
  ctx: CodeModeToolContext,
  input: CodeModeToolCall,
): Promise<CodeModeCallResolution> {
  const callbacks = createHook<DeliverHookPayload>();
  await claimHookOwnership(callbacks);
  try {
    const iterator = callbacks[Symbol.asyncIterator]();
    const call = { ...input, authorizationHookToken: callbacks.token };
    let outcome = await executeCodeModeToolStep(call);
    while (outcome.status === "authorization-required") {
      outcome = await resumeAfterAuthorization(ctx, call, iterator, outcome.challenges);
    }
    return outcome;
  } finally {
    await disposeHook(callbacks);
  }
}

async function resumeAfterAuthorization(
  ctx: CodeModeToolContext,
  call: CodeModeToolCall & { readonly authorizationHookToken: string },
  callbacks: AsyncIterator<DeliverHookPayload>,
  challenges: readonly AuthorizationChallenge[],
): Promise<CodeModeToolOutcome> {
  if (challenges.length === 0) throw new Error("Authorization returned no challenge.");
  try {
    for (const challenge of challenges) {
      await publishAuthorizationEvent(
        ctx,
        createAuthorizationRequiredEvent({
          ...coordinates(ctx),
          attemptId: challenge.attemptId,
          authorization: challenge.challenge,
          candidateId: challenge.candidateId,
          description:
            challenge.challenge.instructions ?? `Authorization required for ${challenge.name}`,
          name: challenge.name,
          webhookUrl: challenge.hookUrl,
        }),
      );
    }
    const authorizationResults = await waitForAuthorizationCallbacks(
      callbacks,
      challenges,
      ctx.abortSignal,
    );
    const outcome = await executeCodeModeToolStep({ ...call, authorizationResults });
    await publishAuthorizationCompletion(ctx, challenges, outcome);
    return outcome;
  } catch (error) {
    await publishAuthorizationCompletion(ctx, challenges, {
      status: "failed",
      error: toErrorMessage(error),
    });
    throw error;
  }
}

async function waitForAuthorizationCallbacks(
  callbacks: AsyncIterator<DeliverHookPayload>,
  challenges: readonly AuthorizationChallenge[],
  signal: AbortSignal,
): Promise<MatchedAuthorizationCallback["result"][]> {
  let remaining = challenges;
  const results: MatchedAuthorizationCallback["result"][] = [];
  while (remaining.length > 0) {
    const next = await nextCallback(callbacks, signal);
    if (next.done) throw new Error("Authorization callback hook closed without a result.");
    if (next.value.kind !== "deliver") continue;
    const { matches } = matchAuthorizationCallbacks({ challenges: remaining }, next.value.payloads);
    for (const { result } of matches) {
      results.push(result);
      remaining = remaining.filter(
        (challenge) => challenge.name !== result.name || challenge.attemptId !== result.attemptId,
      );
    }
  }
  return results;
}

async function publishAuthorizationCompletion(
  ctx: CodeModeToolContext,
  challenges: readonly AuthorizationChallenge[],
  outcome: CodeModeToolOutcome,
): Promise<void> {
  for (const challenge of challenges) {
    await publishAuthorizationEvent(
      ctx,
      createAuthorizationCompletedEvent({
        ...coordinates(ctx),
        attemptId: challenge.attemptId,
        authorization: challenge.challenge,
        candidateId: challenge.candidateId,
        name: challenge.name,
        outcome: outcome.status === "failed" ? "failed" : "authorized",
        reason: outcome.status === "failed" ? outcome.error : undefined,
      }),
    );
  }
}

function coordinates(ctx: CodeModeToolContext) {
  const { sequence, stepIndex, turnId } = readWorkflowToolRunRef(ctx);
  return { sequence, stepIndex, turnId };
}

async function publishAuthorizationEvent(
  ctx: CodeModeToolContext,
  event: SubagentAuthorizationEvent,
): Promise<void> {
  const from = readWorkflowToolRunRef(ctx);
  const owner = readWorkflowToolRunOwner(ctx);
  await resumeHookStep(
    owner.inbox,
    {
      kind: "request",
      from,
      replyTo: from.runId,
      request: {
        kind: "authorization-request",
        event: {
          callId: from.callId,
          childSessionId: from.runId,
          event,
          kind: "subagent-authorization-event",
          subagentName: from.toolName,
        },
      },
    },
    { ifPresent: event.type === "authorization.completed" },
  );
}

async function nextCallback(
  iterator: AsyncIterator<DeliverHookPayload>,
  signal: AbortSignal,
): Promise<IteratorResult<DeliverHookPayload>> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([iterator.next(), cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
