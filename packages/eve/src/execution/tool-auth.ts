import { buildBaseToolContext } from "#context/build-base-tool-context.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { ApprovalResponseAuth } from "#approval/definition.js";
import type { ToolAuthOptions, ToolContext, ToolExecuteOptions } from "#tools/definition.js";
import type { TaskExec } from "#tools/task.js";
import { createAuthorizationContext } from "#runtime/authorization-context.js";
import { handleAuthorizationError } from "#runtime/connections/scoped-authorization.js";

type ToolExecuteWithAuthInput<TInput> = {
  readonly scope: string;
} & (
  | {
      readonly execution: "background";
      readonly execute: (toolInput: TInput, ctx: ToolContext, task: TaskExec) => unknown;
    }
  | {
      readonly execution?: never;
      readonly execute: (toolInput: TInput, ctx: ToolContext, task?: TaskExec) => unknown;
    }
);

/** Supplies the shared auth capability to one authored tool execution. */
export function createToolExecuteWithAuth<TInput>(input: ToolExecuteWithAuthInput<TInput>) {
  return (toolInput: TInput, options: ToolExecuteOptions, task?: TaskExec) => {
    const auth = createAuthorizationContext({ scope: input.scope });
    const ctx: ToolContext = {
      ...buildBaseToolContext({ options, toolName: input.scope }),
      getToken: auth.getToken,
      requireAuth: auth.requireAuth,
    };
    return auth.run(() => {
      if (input.execution === "background") {
        if (task === undefined)
          throw new Error("Background tool execution requires a task runtime.");
        return input.execute(toolInput, ctx, task);
      }
      return input.execute(toolInput, ctx, task);
    });
  };
}

/** Binds the same capability to the person responding to an approval. */
export function buildApprovalResponseAuth(input: {
  readonly responder: SessionAuthContext;
  readonly scope: string;
}): ApprovalResponseAuth {
  const auth = createAuthorizationContext({ scope: input.scope, boundResponder: input.responder });
  return {
    getToken: (provider, options) =>
      auth.getToken(provider, namespaceApprovalAuthOptions(input.scope, options)),
    requireAuth: (provider, options) =>
      auth.requireAuth(provider, namespaceApprovalAuthOptions(input.scope, options)),
  };
}

function namespaceApprovalAuthOptions(
  scope: string,
  options: ToolAuthOptions | undefined,
): ToolAuthOptions | undefined {
  return options?.authKey === undefined
    ? options
    : { ...options, authKey: `${scope}:${options.authKey}` };
}

/** Starts authorization requested by an approval response authorizer. */
export async function handleApprovalResponsePolicyError(error: unknown): Promise<unknown> {
  return await handleAuthorizationError(error);
}
