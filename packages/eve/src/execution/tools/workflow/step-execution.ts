import { getStepMetadata } from "#compiled/@workflow/core/index.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, InitiatorAuthKey, SessionIdKey, SessionKey } from "#context/keys.js";
import { isConnectionAuthorizationFailedError } from "#connections/errors.js";
import {
  isAuthorizationSignal,
  PendingAuthorizationResultKey,
  WorkflowAuthorizationAttemptKey,
} from "#harness/authorization.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import {
  type WorkflowStepInvocation,
  type WorkflowStepResult,
} from "#execution/tools/workflow/step-context.js";

/** Keeps token capabilities and bearer values inside the executing step. */
export function withWorkflowStepAuthorization(execute: (...args: never[]) => unknown) {
  const wrapped = async (invocation: WorkflowStepInvocation): Promise<unknown> => {
    const { args, context: input } = invocation;
    if (input === undefined) return execute(...(args as never[]));
    getStepMetadata();
    const context = new ContextContainer();
    context.set(AuthKey, input.session.auth.current);
    context.set(InitiatorAuthKey, input.session.auth.initiator);
    context.set(SessionIdKey, input.session.id);
    context.setVirtualContext(SessionKey, { ...input.session, sessionId: input.session.id });
    context.setVirtualContext(WorkflowAuthorizationAttemptKey, {
      baseUrl: resolveWorkflowCallbackBaseUrl(input.baseUrl),
      token: input.token,
    });
    context.setVirtualContext(PendingAuthorizationResultKey, input.authorizationResults);

    return contextStorage.run(context, async (): Promise<WorkflowStepResult> => {
      const run = createToolExecuteWithAuth({
        scope: input.from.toolName,
        execute: (_input, ctx) =>
          execute(
            ...(args.map((arg, index) =>
              invocation.contextIndexes?.includes(index) ? ctx : arg,
            ) as never[]),
          ),
      });
      let output: unknown;
      try {
        output = await run(
          {},
          { abortSignal: input.abortSignal, toolCallId: input.from.callId, messages: [] },
        );
      } catch (error) {
        // The Workflow SDK recognizes fatal=true; preserve eve's classified error fields.
        if (isConnectionAuthorizationFailedError(error) && !error.retryable)
          Object.assign(error, { fatal: true });
        throw error;
      }
      const remaining = context.get(PendingAuthorizationResultKey) ?? [];
      const authorized = input.authorizationResults
        .filter((result) => !remaining.includes(result))
        .map((result) => result.attemptId!);
      return isAuthorizationSignal(output)
        ? { kind: "eve:workflow-step-authorization", signal: output, authorized }
        : { kind: "eve:workflow-step-result", output, authorized };
    });
  };
  // The SDK reads retry policy from the registered function at execution time.
  Object.defineProperty(wrapped, "maxRetries", { get: () => Reflect.get(execute, "maxRetries") });
  return wrapped;
}
