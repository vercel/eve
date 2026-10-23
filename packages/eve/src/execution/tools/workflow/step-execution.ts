import { getStepMetadata } from "#compiled/@workflow/core/index.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, InitiatorAuthKey, SandboxKey, SessionIdKey, SessionKey } from "#context/keys.js";
import type { SessionContext } from "#context/session-context.js";
import { ensureSandboxAccess, type EnsuredSandboxAccess } from "#execution/sandbox/ensure.js";
import { createLogger, logError } from "#internal/logging.js";
import { resolveDurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { SandboxEnvironmentIdentity } from "#shared/sandbox-environment.js";
import type { SandboxAccess } from "#sandbox/state.js";
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
  type WorkflowStepContext,
  type WorkflowStepInvocation,
  type WorkflowStepResult,
} from "#execution/tools/workflow/step-context.js";

const log = createLogger("workflow-step");

/** Keeps token capabilities and bearer values inside the executing step. */
export function withWorkflowStepAuthorization(execute: (...args: never[]) => unknown) {
  const wrapped = async function (
    this: unknown,
    invocation: WorkflowStepInvocation,
  ): Promise<unknown> {
    const { args, context: input } = invocation;
    getStepMetadata();
    const context = new ContextContainer();
    context.set(AuthKey, input.session.auth.current);
    context.set(InitiatorAuthKey, input.session.auth.initiator);
    context.set(SessionIdKey, input.session.id);
    context.setVirtualContext(SessionKey, { ...input.session, sessionId: input.session.id });
    context.set(CallbackBaseUrlKey, resolveWorkflowCallbackBaseUrl(input.baseUrl));
    context.setVirtualContext(AuthorizationHookKey, input.token);
    context.setVirtualContext(PendingAuthorizationResultKey, input.authorizationResults);

    const sandbox = openStepSandbox(input);
    return contextStorage.run(context, async (): Promise<WorkflowStepResult> => {
      const auth = createAuthorizationContext({
        scope: input.toolName,
        completeAuthorization: completeWorkflowStepAuthorization,
      });
      const base = buildBaseToolContext({
        toolName: input.toolName,
        options: { abortSignal: input.abortSignal, toolCallId: input.callId },
      });
      const ctx = {
        ...base,
        agent: () => unavailableInStep("ctx.agent()", "Call ctx.agent() in the workflow body."),
        ask: () => unavailableInStep("ctx.ask()", "Call ctx.ask() in the workflow body."),
        getSandbox: (async (environment?: SandboxEnvironmentIdentity) => {
          const access = await sandbox.open();
          // The step imports its own copy of the module that declares the
          // environment, so it can't match by identity. An agent has one
          // sandbox definition, and the argument only narrows the type, so
          // the provider is enough.
          if (environment !== undefined && access.environment?.provider !== environment.provider) {
            throw fatal(
              'ctx.getSandbox() in a "use step" function received a sandbox environment the session\'s sandbox does not use. ' +
                "Pass the environment the agent's sandbox definition opens, or call ctx.getSandbox() without one.",
            );
          }
          context.setVirtualContext(SandboxKey, access);
          return await base.getSandbox();
        }) as SessionContext["getSandbox"],
        getToken: auth.getToken,
        requireAuth: auth.requireAuth,
      };
      Object.defineProperty(ctx, "agents", {
        get: () =>
          unavailableInStep(
            "ctx.agents",
            "Read ctx.agents in the workflow body and pass the required serializable metadata into the step.",
          ),
      });
      let output: unknown;
      try {
        output = await auth.run(() =>
          Reflect.apply(
            execute,
            this,
            args.map((arg, index) => (invocation.contextIndexes.includes(index) ? ctx : arg)),
          ),
        );
      } catch (error) {
        // The Workflow SDK recognizes fatal=true; preserve eve's classified error fields.
        if (isConnectionAuthorizationFailedError(error) && !error.retryable) {
          Object.assign(error, { fatal: true });
        }
        throw error;
      } finally {
        await sandbox.release();
      }
      const remaining = context.get(PendingAuthorizationResultKey) ?? [];
      const authorized = input.authorizationResults
        .filter((result) => !remaining.includes(result))
        .map((result) => result.attemptId);
      return isAuthorizationSignal(output)
        ? { kind: "authorization-required", signal: output, authorized }
        : { kind: "result", output, authorized };
    });
  };
  // The SDK reads retry policy from the registered function at execution time.
  Object.defineProperty(wrapped, "maxRetries", { get: () => Reflect.get(execute, "maxRetries") });
  return wrapped;
}

/**
 * The calling session's sandbox, opened on the step's first `ctx.getSandbox()`
 * under the key of the session that owns it, and closed when the step ends.
 * Recorded state, when the call captured it, resumes the sandbox; without
 * it, or when that sandbox is gone, the provider's `start` upserts it by that
 * key with the owner's sandbox definition, so the session finds the same
 * sandbox and its session-end cleanup removes it. The step never owns the
 * sandbox: the session's turns may be using it, so the step can neither stop
 * nor delete it.
 * A step that never asks for it loads nothing.
 */
function openStepSandbox(input: WorkflowStepContext) {
  const { bundle, sessionId, state } = input.sandbox;
  // The step's own context replaces the delivery's, which carries the
  // development generation a development source resolves to.
  const delivery = contextStorage.getStore();
  const resolveSource = () => resolveDurableCompiledArtifactsSource(bundle.source);
  let opening: Promise<EnsuredSandboxAccess> | undefined;
  let released = false;
  const open = async (): Promise<EnsuredSandboxAccess> => {
    const compiled = await getCompiledRuntimeAgentBundle({
      compiledArtifactsSource:
        delivery === undefined ? resolveSource() : contextStorage.run(delivery, resolveSource),
      nodeId: bundle.nodeId,
    });
    const node = compiled.graph.root;
    return await ensureSandboxAccess({
      compiledArtifactsSource: compiled.compiledArtifactsSource,
      nodeId: node.nodeId,
      ownsSandbox: false,
      registry: node.sandboxRegistry,
      sessionId,
      state: state ?? null,
      shutdownTracking: "none",
    });
  };
  const openOnce = (): Promise<EnsuredSandboxAccess> => {
    opening ??= open().catch((error: unknown) => {
      opening = undefined;
      throw error;
    });
    return opening;
  };
  return {
    async open(): Promise<SandboxAccess> {
      if (released) {
        throw fatal(
          `ctx.getSandbox() was called after the "use step" function of tool "${input.toolName}" returned. ` +
            "Call it inside the step, which lets go of the sandbox when it ends.",
        );
      }
      const access = await openOnce();
      return {
        ...access,
        delete: () =>
          unavailableInStep(
            "sandbox.delete()",
            "The step borrows the session's sandbox, and only the session can delete it.",
          ),
        stop: () =>
          unavailableInStep(
            "sandbox.stop()",
            "The session's turns may be using the sandbox; eve closes the step's connection when the step ends.",
          ),
      };
    },
    async release(): Promise<void> {
      released = true;
      const access = await opening?.catch(() => undefined);
      try {
        await access?.release();
      } catch (error) {
        logError(log, "failed to release a workflow step's sandbox", error, {
          sessionId,
          toolName: input.toolName,
        });
      }
    },
  };
}

function unavailableInStep(capability: string, guidance: string): never {
  throw fatal(`${capability} is unavailable inside a "use step" function. ${guidance}`);
}

/** A misuse a retry would repeat, which the Workflow SDK fails without retrying. */
function fatal(message: string): Error {
  return Object.assign(new Error(message), { fatal: true });
}
