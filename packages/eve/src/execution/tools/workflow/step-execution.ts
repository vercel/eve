import { getStepMetadata } from "#compiled/@workflow/core/index.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, InitiatorAuthKey, SessionIdKey, SessionKey } from "#context/keys.js";
import { isConnectionAuthorizationFailedError } from "#connections/errors.js";
import {
  isAuthorizationSignal,
  PendingAuthorizationResultKey,
  AuthorizationHookKey,
  CallbackBaseUrlKey,
} from "#harness/authorization.js";
import { createAuthorizationContext } from "#runtime/authorization-context.js";
import { buildBaseToolContext } from "#context/build-base-tool-context.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { completeWorkflowStepAuthorization } from "#execution/tools/workflow/authorization-completion.js";
import {
  type WorkflowStepInvocation,
  type WorkflowStepResult,
} from "#execution/tools/workflow/step-context.js";

/** Keeps token capabilities and bearer values inside the executing step. */
export function withWorkflowStepAuthorization(execute: (...args: never[]) => unknown) {
  const wrapped = async function (
    this: unknown,
    invocation: WorkflowStepInvocation,
  ): Promise<unknown> {
    const { args, context: input } = invocation;
    if (input === undefined) return Reflect.apply(execute, this, args);
    getStepMetadata();
    const context = new ContextContainer();
    context.set(AuthKey, input.session.auth.current);
    context.set(InitiatorAuthKey, input.session.auth.initiator);
    context.set(SessionIdKey, input.session.id);
    context.setVirtualContext(SessionKey, { ...input.session, sessionId: input.session.id });
    context.set(CallbackBaseUrlKey, resolveWorkflowCallbackBaseUrl(input.baseUrl));
    context.setVirtualContext(AuthorizationHookKey, {
      token: input.token,
      attemptId: input.token,
    });
    context.setVirtualContext(PendingAuthorizationResultKey, input.authorizationResults);

    return contextStorage.run(context, async (): Promise<WorkflowStepResult> => {
      const auth = createAuthorizationContext({
        scope: input.from.toolName,
        completeAuthorization: completeWorkflowStepAuthorization,
      });
      const ctx = {
        ...buildBaseToolContext({
          toolName: input.from.toolName,
          options: { abortSignal: input.abortSignal, toolCallId: input.from.callId },
        }),
        getToken: auth.getToken,
        requireAuth: auth.requireAuth,
      };
      let output: unknown;
      try {
        output = await auth.run(() =>
          Reflect.apply(
            execute,
            this,
            args.map((arg, index) => (invocation.contextIndexes?.includes(index) ? ctx : arg)),
          ),
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
