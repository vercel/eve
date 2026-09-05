import { createHook, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import type { AuthorizationChallenge, AuthorizationResult } from "#harness/authorization.js";
import type { AuthorizationCallback } from "#shared/connection-types.js";
import type { ToolContext } from "#tools/definition.js";
import { findWorkflowToolRunContext } from "#execution/tools/workflow/ask.js";
import { disposeHook } from "#execution/hook-ownership.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import {
  createAuthorizationRequiredEvent,
  createAuthorizationCompletedEvent,
} from "#protocol/message.js";
import type {
  WorkflowStepContext,
  WorkflowStepInvocation,
  WorkflowStepResult,
} from "#execution/tools/workflow/step-context.js";

/** Wraps a step proxy only when the caller explicitly passes its workflow tool context. */
export function workflowToolStep(
  execute: (invocation: WorkflowStepInvocation) => Promise<unknown>,
) {
  return async (...args: unknown[]): Promise<unknown> => {
    const index = args.findIndex((arg) => findWorkflowToolRunContext(arg) !== undefined);
    if (index === -1) return execute({ args });
    const ctx = args[index] as ToolContext;
    const run = findWorkflowToolRunContext(ctx)!;
    const authorizationResults: (AuthorizationResult & { name: string })[] = [];
    const pending = new Map<string, AuthorizationChallenge>();
    for (;;) {
      const callback = createHook<unknown>();
      const input: WorkflowStepContext = {
        from: run.from,
        owner: run.owner,
        session: ctx.session,
        abortSignal: ctx.abortSignal,
        baseUrl: getWorkflowMetadata().url,
        token: callback.token,
        authorizationResults,
      };
      try {
        const invocation: WorkflowStepInvocation = {
          args: args.map((arg) => (arg === ctx ? null : arg)),
          context: input,
          contextIndexes: args.flatMap((arg, index) => (arg === ctx ? [index] : [])),
        };
        let result: WorkflowStepResult;
        try {
          result = (await execute(invocation)) as WorkflowStepResult;
        } catch (error) {
          if (!ctx.abortSignal.aborted)
            for (const challenge of pending.values())
              await reportAuthorization(input, challenge, "failed");
          throw error;
        }
        for (const attemptId of result.authorized) {
          const challenge = pending.get(attemptId);
          if (challenge !== undefined) await reportAuthorization(input, challenge, "authorized");
          pending.delete(attemptId);
        }
        for (let i = authorizationResults.length - 1; i >= 0; i--) {
          if (result.authorized.includes(authorizationResults[i]!.attemptId!))
            authorizationResults.splice(i, 1);
        }
        if (result.kind === "eve:workflow-step-result") {
          for (const challenge of pending.values())
            await reportAuthorization(input, challenge, "failed");
          return result.output;
        }
        for (const challenge of result.signal.challenges) {
          pending.set(challenge.attemptId!, challenge);
          await reportAuthorization(input, challenge);
          try {
            const response = await waitForCallback(callback, challenge, ctx.abortSignal);
            authorizationResults.push({
              name: challenge.name,
              instanceId: challenge.instanceId,
              attemptId: challenge.attemptId,
              hookUrl: challenge.hookUrl,
              principal: challenge.principal,
              resume: challenge.resume,
              callback: response,
            });
          } catch (error) {
            // Cancelled turns close their inbox; cancelled tasks discard further deliveries.
            if (!ctx.abortSignal.aborted) await reportAuthorization(input, challenge, "failed");
            throw error;
          }
        }
      } finally {
        await disposeHook(callback);
      }
    }
  };
}

async function reportAuthorization(
  input: WorkflowStepContext,
  challenge: AuthorizationChallenge,
  outcome?: "authorized" | "failed",
): Promise<void> {
  const eventInput = {
    attemptId: challenge.attemptId,
    name: challenge.name,
    sequence: input.from.sequence,
    stepIndex: input.from.stepIndex,
    turnId: input.from.turnId,
    authorization: challenge.challenge,
  };
  const acknowledged = createHook<void>();
  try {
    await withAbort(
      resumeHookStep(input.owner.inbox, {
        kind: "request",
        from: input.from,
        replyTo: acknowledged.token,
        request: {
          kind: "authorization-request",
          stepAuthorization: true,
          event: {
            kind: "subagent-authorization-event",
            callId: input.from.callId,
            childSessionId: input.from.runId,
            subagentName: input.from.toolName,
            event:
              outcome === undefined
                ? createAuthorizationRequiredEvent({
                    ...eventInput,
                    description: `Sign in to ${challenge.name} to continue.`,
                    webhookUrl: challenge.hookUrl,
                  })
                : createAuthorizationCompletedEvent({ ...eventInput, outcome }),
          },
        },
      }),
      input.abortSignal,
    );
    await withAbort(acknowledged, input.abortSignal);
  } finally {
    await disposeHook(acknowledged);
  }
}

async function waitForCallback(
  hook: AsyncIterable<unknown>,
  challenge: AuthorizationChallenge,
  signal: AbortSignal,
): Promise<AuthorizationCallback> {
  const iterator = hook[Symbol.asyncIterator]();
  for (;;) {
    const next = await withAbort(iterator.next(), signal);
    if (next.done) throw new Error("Authorization callback closed before sign-in completed.");
    const callback = readCallback(next.value, challenge);
    if (callback !== undefined) return callback;
  }
}

async function withAbort<T>(pending: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new Error("Workflow authorization cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function readCallback(
  value: unknown,
  challenge: AuthorizationChallenge,
): AuthorizationCallback | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("payloads" in value) ||
    !Array.isArray(value.payloads)
  )
    return undefined;
  for (const payload of value.payloads) {
    const received = payload?.authorizationCallback;
    if (received?.attemptId !== challenge.attemptId || received?.connectionName !== challenge.name)
      continue;
    const callback = received.callback;
    if (
      typeof callback?.method !== "string" ||
      typeof callback.params !== "object" ||
      callback.params === null ||
      Array.isArray(callback.params)
    )
      continue;
    if (!Object.values(callback.params).every((param) => typeof param === "string")) continue;
    if (callback.body !== undefined && typeof callback.body !== "string") continue;
    return callback;
  }
  return undefined;
}
