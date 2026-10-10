import { buildBaseToolContext } from "#context/build-base-tool-context.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { ApprovalResponseAuth } from "#approval/definition.js";
import type {
  ToolApproval,
  ToolAuthOptions,
  ToolContext,
  ToolExecuteOptions,
} from "#tools/definition.js";
import { createAuthorizationContext } from "#runtime/authorization-context.js";
import {
  handleAuthorizationError,
  isScopedAuthorizationRequiredError,
} from "#runtime/connections/scoped-authorization.js";
import {
  ConnectionAuthorizationFailedError,
  isConnectionAuthorizationRequiredError,
} from "#connections/errors.js";

type ToolExecuteWithAuthInput<TInput> = {
  readonly scope: string;
  readonly execute: (toolInput: TInput, ctx: ToolContext) => unknown;
};

/** Supplies the shared auth capability to one authored tool execution. */
export function createToolExecuteWithAuth<TInput>(input: ToolExecuteWithAuthInput<TInput>) {
  return (toolInput: TInput, options: ToolExecuteOptions) => {
    const auth = createAuthorizationContext({ scope: input.scope });
    const ctx: ToolContext = {
      ...buildBaseToolContext({ options, toolName: input.scope }),
      messages: options.messages,
      getToken: auth.getToken,
      requireAuth: auth.requireAuth,
      ...(options.approval !== undefined && {
        approval: approvalOf(options.approval.responder, input.scope),
      }),
    };
    return auth.run(() => {
      return input.execute(toolInput, ctx);
    });
  };
}

/** What an approved call reads about the person who approved it. */
function approvalOf(responder: SessionAuthContext, scope: string): ToolApproval {
  const auth = buildApprovalResponseAuth({ responder, scope });
  return {
    // The approver isn't in this call, so a missing token fails the call rather than
    // reaching the enclosing boundary, which would start a sign-in.
    getToken: async (provider, options) => {
      try {
        return await auth.getToken(provider, options);
      } catch (error) {
        if (
          isScopedAuthorizationRequiredError(error) ||
          isConnectionAuthorizationRequiredError(error)
        ) {
          throw new ConnectionAuthorizationFailedError(scope, {
            message: `The approver of "${scope}" has no token for this provider, and an approved call doesn't start a sign-in.`,
            reason: "approver_authorization_required",
            retryable: false,
          });
        }
        throw error;
      }
    },
    responder,
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
