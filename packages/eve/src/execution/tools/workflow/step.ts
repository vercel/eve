import { createHook, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import { attributeSignInFailure, ConnectionAuthorizationFailedError } from "#connections/errors.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { AuthorizationCallback } from "#shared/connection-types.js";
import type { ToolContext } from "#tools/definition.js";
import {
  findWorkflowToolRunContext,
  type WorkflowToolRunContext,
} from "#execution/tools/workflow/ask.js";
import { disposeHook } from "#execution/hook-ownership.js";
import type { WorkflowAuthorizationAcknowledgement } from "#execution/tools/workflow/owner.js";
import { signInAlreadyFailedError } from "#harness/hitl/sign-ins.js";
import { runSignIn } from "#harness/session-machine/transitions.js";
import type {
  WorkflowStepAuthorizationResult,
  WorkflowStepContext,
  WorkflowStepInvocation,
  WorkflowStepResult,
} from "#execution/tools/workflow/step-context.js";

type IdentifiedAuthorizationChallenge = AuthorizationChallenge & { readonly attemptId: string };

interface WorkflowContextArgument {
  readonly ctx: ToolContext;
  readonly run: WorkflowToolRunContext;
}

/** Wraps a step proxy only when the caller explicitly passes its workflow tool context. */
export function workflowToolStep(
  original: (...args: unknown[]) => Promise<unknown>,
  execute: (invocation: WorkflowStepInvocation) => Promise<unknown>,
) {
  // Forward the SDK proxy's stepId, bind implementation, and serialization metadata.
  // A revived reference still calls the original registered function with native arguments.
  return new Proxy(original, {
    apply(target, receiver, args: unknown[]) {
      const contextArgument = findWorkflowContextArgument(args);
      if (contextArgument === undefined) {
        return Reflect.apply(target, receiver, args);
      }
      return executeAuthorizedStep(execute, receiver, args, contextArgument);
    },
  });
}

function findWorkflowContextArgument(
  args: readonly unknown[],
): WorkflowContextArgument | undefined {
  for (const arg of args) {
    const run = findWorkflowToolRunContext(arg);
    if (run !== undefined) {
      return { ctx: arg as ToolContext, run };
    }
  }
  return undefined;
}

async function executeAuthorizedStep(
  execute: (invocation: WorkflowStepInvocation) => Promise<unknown>,
  receiver: unknown,
  args: unknown[],
  contextArgument: WorkflowContextArgument,
): Promise<unknown> {
  const { ctx, run } = contextArgument;
  const authorizationResults: WorkflowStepAuthorizationResult[] = [];
  const pending = new Map<string, IdentifiedAuthorizationChallenge>();

  for (;;) {
    const callback = createHook<unknown>();
    try {
      let result: WorkflowStepResult;
      try {
        result = await invokeAuthorizedStep({
          args,
          authorizationResults,
          callbackToken: callback.token,
          ctx,
          execute,
          receiver,
        });
      } catch (error) {
        if (!ctx.abortSignal.aborted) {
          await reportPendingAsFailed(run, ctx.abortSignal, pending, error);
        }
        throw error;
      }

      await reconcileCompletedAuthorizations(
        run,
        ctx.abortSignal,
        pending,
        authorizationResults,
        result.authorized,
      );

      if (result.kind === "result") {
        if (result.failure === undefined) {
          await reportPendingAsFailed(run, ctx.abortSignal, pending);
          return result.output;
        }
        const { connectionName, message, reason, signIn } = result.failure;
        const failure = new ConnectionAuthorizationFailedError(connectionName, {
          message,
          ...(reason !== undefined && { reason }),
          retryable: false,
        });
        if (signIn !== undefined) attributeSignInFailure(failure, signIn);
        await reportPendingAsFailed(run, ctx.abortSignal, pending, failure);
        throw failure;
      }

      await collectAuthorizationCallbacks({
        authorizationResults,
        callback,
        challenges: result.signal.challenges,
        ctx,
        pending,
        run,
      });
    } finally {
      await disposeHook(callback);
    }
  }
}

async function invokeAuthorizedStep(input: {
  readonly args: unknown[];
  readonly authorizationResults: readonly WorkflowStepAuthorizationResult[];
  readonly callbackToken: string;
  readonly ctx: ToolContext;
  readonly execute: (invocation: WorkflowStepInvocation) => Promise<unknown>;
  readonly receiver: unknown;
}): Promise<WorkflowStepResult> {
  const { args, authorizationResults, callbackToken, ctx, execute, receiver } = input;
  const context: WorkflowStepContext = {
    callId: ctx.callId,
    toolName: ctx.toolName,
    session: ctx.session,
    abortSignal: ctx.abortSignal,
    baseUrl: getWorkflowMetadata().url,
    token: callbackToken,
    authorizationResults,
  };
  const invocation: WorkflowStepInvocation = {
    args: args.map((arg) => (arg === ctx ? null : arg)),
    context,
    contextIndexes: args.flatMap((arg, index) => (arg === ctx ? [index] : [])),
  };
  return (await execute.call(receiver, invocation)) as WorkflowStepResult;
}

async function reconcileCompletedAuthorizations(
  run: WorkflowToolRunContext,
  signal: AbortSignal,
  pending: Map<string, IdentifiedAuthorizationChallenge>,
  authorizationResults: WorkflowStepAuthorizationResult[],
  authorizedAttemptIds: readonly string[],
): Promise<void> {
  const authorized = new Set(authorizedAttemptIds);
  for (const attemptId of authorized) {
    const challenge = pending.get(attemptId);
    if (challenge !== undefined) {
      await reportAuthorization(run, signal, challenge, "authorized");
    }
    pending.delete(attemptId);
  }

  for (let index = authorizationResults.length - 1; index >= 0; index--) {
    const result = authorizationResults[index];
    if (result !== undefined && authorized.has(result.attemptId)) {
      authorizationResults.splice(index, 1);
    }
  }
}

async function collectAuthorizationCallbacks(input: {
  readonly authorizationResults: WorkflowStepAuthorizationResult[];
  readonly callback: AsyncIterable<unknown>;
  readonly challenges: readonly AuthorizationChallenge[];
  readonly ctx: ToolContext;
  readonly pending: Map<string, IdentifiedAuthorizationChallenge>;
  readonly run: WorkflowToolRunContext;
}): Promise<void> {
  const { authorizationResults, callback, challenges, ctx, pending, run } = input;
  for (const challenge of challenges) {
    const identified = requireAttemptId(challenge);
    const refused = await reportAuthorization(run, ctx.abortSignal, identified);
    if (refused !== null) {
      await reportPendingAsFailed(run, ctx.abortSignal, pending);
      throw signInAlreadyFailedError(identified.name, refused);
    }
    pending.set(identified.attemptId, identified);

    try {
      const response = await waitForCallback(callback, identified, ctx.abortSignal);
      authorizationResults.push({
        name: identified.name,
        instanceId: identified.instanceId,
        attemptId: identified.attemptId,
        hookUrl: identified.hookUrl,
        principal: identified.principal,
        resume: identified.resume,
        callback: response,
      });
    } catch (error) {
      // Cancelled turns close their inbox; cancelled tasks discard further deliveries.
      if (!ctx.abortSignal.aborted) {
        await reportAuthorization(run, ctx.abortSignal, identified, { failure: error });
      }
      throw error;
    }
  }
}

function requireAttemptId(challenge: AuthorizationChallenge): IdentifiedAuthorizationChallenge {
  if (challenge.attemptId === undefined) {
    throw new Error(`Workflow authorization challenge "${challenge.name}" has no attempt id.`);
  }
  return challenge as IdentifiedAuthorizationChallenge;
}

async function reportPendingAsFailed(
  run: WorkflowToolRunContext,
  signal: AbortSignal,
  pending: ReadonlyMap<string, IdentifiedAuthorizationChallenge>,
  failure?: unknown,
): Promise<void> {
  for (const challenge of pending.values()) {
    await reportAuthorization(run, signal, challenge, { failure });
  }
}

/** Reports one sign-in event; the session answers whether it relayed a request for one. */
async function reportAuthorization(
  run: WorkflowToolRunContext,
  signal: AbortSignal,
  challenge: IdentifiedAuthorizationChallenge,
  outcome?: Parameters<typeof runSignIn>[2],
): Promise<WorkflowAuthorizationAcknowledgement> {
  const event = runSignIn(run.from, challenge, outcome);
  const acknowledged = createHook<WorkflowAuthorizationAcknowledgement>();
  try {
    // The relay can run before this suspension registers the hook, and the
    // session's acknowledgement skips a hook it can't find. A generated token
    // can't conflict, so this only waits for registration.
    await acknowledged.getConflict();
    await withAbort(
      run.owner.send({
        kind: "request",
        from: run.from,
        replyTo: acknowledged.token,
        request: {
          kind: "authorization-request",
          event: {
            kind: "subagent-authorization-event",
            callId: run.from.callId,
            childSessionId: run.from.runId,
            subagentName: run.from.toolName,
            event,
          },
        },
      }),
      signal,
    );
    return await withAbort(acknowledged, signal);
  } finally {
    await disposeHook(acknowledged);
  }
}

async function waitForCallback(
  hook: AsyncIterable<unknown>,
  challenge: IdentifiedAuthorizationChallenge,
  signal: AbortSignal,
): Promise<AuthorizationCallback> {
  const iterator = hook[Symbol.asyncIterator]();
  for (;;) {
    const next = await withAbort(iterator.next(), signal);
    if (next.done) {
      throw new Error("Authorization callback closed before sign-in completed.");
    }
    const callback = readCallback(next.value, challenge);
    if (callback !== undefined) {
      return callback;
    }
  }
}

async function withAbort<T>(pending: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new Error("Workflow authorization cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function readCallback(
  value: unknown,
  challenge: IdentifiedAuthorizationChallenge,
): AuthorizationCallback | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("payloads" in value) ||
    !Array.isArray(value.payloads)
  ) {
    return undefined;
  }

  for (const payload of value.payloads) {
    const received = payload?.authorizationCallback;
    if (
      received?.attemptId !== challenge.attemptId ||
      received?.connectionName !== challenge.name
    ) {
      continue;
    }
    const callback = received.callback;
    if (
      typeof callback?.method !== "string" ||
      typeof callback.params !== "object" ||
      callback.params === null ||
      Array.isArray(callback.params)
    ) {
      continue;
    }
    if (!Object.values(callback.params).every((param) => typeof param === "string")) {
      continue;
    }
    if (callback.body !== undefined && typeof callback.body !== "string") {
      continue;
    }
    return callback;
  }
  return undefined;
}
