import { createHook } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, SubagentAuthorizationEvent } from "#channel/types.js";
import {
  matchAuthorizationCallbacks,
  type MatchedAuthorizationCallback,
} from "#execution/authorization-callback-match.js";
import { executeCodeModeToolStep } from "#execution/code-mode/program-step.js";
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

/** Owns callbacks for one nested call; the parent only forwards its authorization events. */
export async function executeCodeModeTool(
  ctx: Pick<ToolContext, "abortSignal" | "callId" | "toolName">,
  input: Omit<
    Parameters<typeof executeCodeModeToolStep>[0],
    "authorizationHookToken" | "authorizationResults"
  >,
): Promise<CodeModeCallResolution> {
  const callbacks = createHook<DeliverHookPayload>();
  const iterator = callbacks[Symbol.asyncIterator]();
  let ownsCallbacks = false;
  let pending: readonly AuthorizationChallenge[] = [];
  try {
    await claimHookOwnership(callbacks);
    ownsCallbacks = true;
    const call = { ...input, authorizationHookToken: callbacks.token };
    let outcome = await executeCodeModeToolStep(call);
    while (outcome.status === "authorization-required") {
      pending = outcome.challenges;
      if (pending.length === 0) throw new Error("Authorization returned no challenge.");
      for (const challenge of pending) {
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
      let remaining = pending;
      const results: MatchedAuthorizationCallback["result"][] = [];
      while (remaining.length > 0) {
        const next = await nextCallback(iterator, ctx.abortSignal);
        if (next.done) throw new Error("Authorization callback hook closed without a result.");
        if (next.value.kind !== "deliver") continue;
        const { matches } = matchAuthorizationCallbacks(
          { challenges: remaining },
          next.value.payloads,
        );
        results.push(...matches.map((match) => match.result));
        remaining = remaining.filter(
          (challenge) =>
            !matches.some(
              ({ result }) =>
                result.name === challenge.name && result.attemptId === challenge.attemptId,
            ),
        );
      }
      outcome = await executeCodeModeToolStep({ ...call, authorizationResults: results });
      for (const challenge of pending) {
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
      pending = [];
    }
    return outcome;
  } catch (error) {
    for (const challenge of pending) {
      await publishAuthorizationEvent(
        ctx,
        createAuthorizationCompletedEvent({
          ...coordinates(ctx),
          attemptId: challenge.attemptId,
          authorization: challenge.challenge,
          candidateId: challenge.candidateId,
          name: challenge.name,
          outcome: "failed",
          reason: toErrorMessage(error),
        }),
      );
    }
    throw error;
  } finally {
    if (ownsCallbacks) await disposeHook(callbacks);
  }
}

function coordinates(ctx: Pick<ToolContext, "abortSignal" | "callId" | "toolName">) {
  const { sequence, stepIndex, turnId } = readWorkflowToolRunRef(ctx);
  return { sequence, stepIndex, turnId };
}

async function publishAuthorizationEvent(
  ctx: Pick<ToolContext, "abortSignal" | "callId" | "toolName">,
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
