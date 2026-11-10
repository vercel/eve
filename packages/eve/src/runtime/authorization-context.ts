import type { SessionAuthContext } from "#channel/types.js";
import { contextStorage } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import { personOf, principalOf, type SessionPerson } from "#context/session-auth.js";
import { ConnectionAuthorizationFailedError } from "#connections/errors.js";
import { sessionParticipants } from "#harness/sender-line.js";
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
  // The person `options.as` names acts through the bound-responder path, guarded as they are.
  const resolveFor = (provider: ToolAuthProvider, options?: ToolAuthOptions) => {
    const scoped = resolve(provider, options);
    if (options?.as === undefined) return scoped;
    if (input.boundResponder !== undefined)
      throw new Error(`"as" names a person for a tool's own ctx.getToken, not for an approver.`);
    const person = namedPerson(options.as, scoped.scope);
    return person === undefined
      ? scoped
      : { ...scoped, boundResponder: { ...person, attributes: {} }, named: true as const };
  };
  return {
    async getToken(
      provider?: ToolAuthProvider,
      options?: ToolAuthOptions,
    ): Promise<TokenResult & { readonly principal?: SessionAuthContext }> {
      if (provider === undefined) throw missingProviderError("ctx.getToken");
      const scoped = resolveFor(provider, options);
      const token = await execution.getToken(scoped);
      return scoped.named === true ? { ...token, principal: scoped.boundResponder } : token;
    },
    /**
     * The given responder's stored token, resolved through this execution's
     * providers; never starts or completes a sign-in.
     */
    async getResponderToken(
      responder: SessionAuthContext,
      provider: ToolAuthProvider,
      options?: ToolAuthOptions,
    ): Promise<TokenResult> {
      return await execution.getResponderToken({
        ...resolve(provider, options),
        boundResponder: responder,
      });
    },
    requireAuth(provider?: ToolAuthProvider, options?: ToolAuthOptions): never {
      if (provider === undefined) throw missingProviderError("ctx.requireAuth");
      return execution.requireAuth(resolveFor(provider, options));
    },
    run: execution.run,
  };
}

/**
 * The person `as` names among those who have spoken in the session, or in the session that
 * delegated to it, or `undefined` for the caller, whose identity a call uses without `as`. A
 * refusal never suggests omitting `as` to act as someone else: the caller may not be the person
 * whose request the call carries out.
 */
function namedPerson(as: string, scope: string): SessionPerson | undefined {
  const ctx = contextStorage.getStore();
  const auth = ctx?.get(AuthKey) ?? null;
  const caller = auth === null || auth.principalType === "anonymous" ? undefined : personOf(auth);
  const participants = sessionParticipants(ctx);
  if (participants === undefined && caller?.principalId === as) return undefined;
  if (participants === undefined) {
    throw new ConnectionAuthorizationFailedError(scope, {
      message: `ctx.getToken can't name "${as}" with "as" here, because this tool runs outside the session's turn. "as" can name a person only from a tool that runs in the turn, and the person must have spoken in this conversation.`,
      reason: "principal_not_found",
      retryable: false,
    });
  }
  const people = new Map(
    [...participants, ...(caller === undefined ? [] : [caller])]
      .filter((person) => person.principalId === as)
      .map((person) => [principalOf(person), person]),
  );
  const matches = [...people.values()];
  if (matches.length === 0) {
    throw new ConnectionAuthorizationFailedError(scope, {
      message: `No one with the principalId "${as}" has spoken in this conversation, so this action can't act as them. The person must have spoken in this conversation: set "as" to the principalId a sender line names them by.`,
      reason: "principal_not_found",
      retryable: false,
    });
  }
  if (matches.length > 1) {
    throw new ConnectionAuthorizationFailedError(scope, {
      message: `More than one person who has spoken in this conversation has the principalId "${as}", signed in different ways, so eve can't tell which one this action should act as. Ask that person to continue in one place, then retry.`,
      reason: "principal_ambiguous",
      retryable: false,
    });
  }
  const [person] = matches;
  return caller !== undefined && principalOf(caller) === principalOf(person!) ? undefined : person;
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
