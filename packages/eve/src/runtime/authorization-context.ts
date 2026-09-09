import type { SessionAuthContext } from "#channel/types.js";
import type { ToolAuthOptions, ToolAuthProvider } from "#tools/definition.js";
import type { AuthorizationDefinition, TokenResult } from "#shared/connection-types.js";
import { normalizeAuthorizationSpec } from "#shared/validate-authorization.js";
import {
  createAuthorizationExecution,
  type ScopedAuthorization,
} from "#runtime/connections/scoped-authorization.js";

/** Shared getToken/requireAuth capability, independent of the executing tool or workflow. */
export function createAuthorizationContext(input: {
  readonly scope: string;
  readonly boundResponder?: SessionAuthContext;
  readonly completeAuthorization?: (scoped: ScopedAuthorization) => Promise<boolean>;
}) {
  const execution = createAuthorizationExecution(input);
  const inlineAuthState: InlineAuthState = {};
  const resolve = (provider: ToolAuthProvider, options?: ToolAuthOptions) =>
    buildInlineScopedAuthorization({ ...input, inlineAuthState, provider, options });
  return {
    async getToken(provider?: ToolAuthProvider, options?: ToolAuthOptions): Promise<TokenResult> {
      if (provider === undefined) throw missingProviderError("ctx.getToken");
      return await execution.getToken(resolve(provider, options));
    },
    requireAuth(provider?: ToolAuthProvider, options?: ToolAuthOptions): never {
      if (provider === undefined) throw missingProviderError("ctx.requireAuth");
      return execution.requireAuth(resolve(provider, options));
    },
    run: execution.run,
  };
}

function buildInlineScopedAuthorization(input: {
  readonly boundResponder?: SessionAuthContext;
  readonly scope: string;
  readonly provider: ToolAuthProvider;
  readonly options?: ToolAuthOptions;
  readonly inlineAuthState: InlineAuthState;
}): ScopedAuthorization {
  const authorization = normalizeInlineProvider(input.provider, input.options);
  return {
    authorization,
    boundResponder: input.boundResponder,
    connection: input.options?.connection ?? { url: "" },
    scope:
      input.options?.authKey === undefined
        ? deriveInlineScope({
            authorization,
            inlineAuthState: input.inlineAuthState,
            provider: input.provider,
            scope: input.scope,
          })
        : validateInlineAuthKey(input.options.authKey),
  };
}

function normalizeInlineProvider(
  provider: ToolAuthProvider,
  options: ToolAuthOptions | undefined,
): AuthorizationDefinition {
  const authorization = normalizeAuthorizationSpec(provider, "ctx.getToken:", "provider");
  if (options?.displayName === undefined) {
    return authorization;
  }
  if (options.displayName.length === 0) {
    throw new Error(`ctx.getToken: The "options.displayName" field must be a non-empty string.`);
  }
  return { ...authorization, displayName: options.displayName };
}

function deriveInlineScope(input: {
  readonly scope: string;
  readonly authorization: AuthorizationDefinition;
  readonly provider: ToolAuthProvider;
  readonly inlineAuthState: InlineAuthState;
}): string {
  const connector = input.authorization.vercelConnect?.connector;
  if (connector !== undefined) {
    return `${input.scope}__${sanitizeScopeSegment(connector)}`;
  }

  if (input.inlineAuthState.anonymousProvider === undefined) {
    input.inlineAuthState.anonymousProvider = input.provider;
  } else if (input.inlineAuthState.anonymousProvider !== input.provider) {
    throw new Error(
      `ctx.getToken: Multiple inline auth providers without provider metadata need explicit auth keys. ` +
        `Pass options.authKey for each provider, for example ` +
        `ctx.getToken(auth, { authKey: "github" }).`,
    );
  }

  return `${input.scope}__inline_auth`;
}

function validateInlineAuthKey(authKey: string): string {
  if (!/^[A-Za-z0-9_.:-]+$/u.test(authKey)) {
    throw new Error(
      `ctx.getToken: The "options.authKey" field must contain only letters, digits, "_", "-", ".", or ":".`,
    );
  }
  return authKey;
}

function sanitizeScopeSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.:-]+/gu, "_").replace(/^_+|_+$/gu, "");
  return sanitized.length > 0 ? sanitized : "provider";
}

interface InlineAuthState {
  anonymousProvider?: ToolAuthProvider;
}

function missingProviderError(method: "ctx.getToken" | "ctx.requireAuth"): Error {
  return new Error(
    `${method}: Pass an auth provider, for example ${method}(connect("github/myagent")).`,
  );
}
