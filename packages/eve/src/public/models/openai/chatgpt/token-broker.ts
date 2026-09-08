import {
  extractCodexAccountIdFromToken,
  extractCodexAccountLabelFromToken,
  readCodexJwtExpirationMs,
} from "./auth.js";
import {
  getDefaultChatGptCredentialStore,
  type ChatGptCredentialStore,
} from "./credential-store.js";
import {
  CodexAppServerClient,
  CodexBinaryNotFoundError,
  type CodexAppServer,
  type CodexAppServerOptions,
} from "./codex-app-server.js";
import {
  CHATGPT_LOGIN_HINT,
  ChatGptSignInRequiredError,
  requestChatGptTokens,
  type ChatGptCredentials,
  type ChatGptRefreshCredentials,
} from "./oauth.js";

const TOKEN_REFRESH_WINDOW_MS = 5 * 60_000;

export type ChatGptAuthState =
  | { readonly kind: "checking" }
  | {
      readonly accountLabel?: string;
      readonly kind: "ready";
    }
  | { readonly kind: "signed-out" }
  | { readonly kind: "reauth-required" }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface ChatGptToken {
  readonly accountId?: string;
  readonly accountLabel?: string;
  readonly expiresAt?: number;
  readonly token: string;
}

export interface CodexTokenBroker {
  credentialOwner(): ChatGptCredentialOwner | undefined;
  getToken(input: { readonly reason: "rejected" | "request" }): Promise<ChatGptToken>;
  refreshState(): Promise<ChatGptAuthState>;
  state(): ChatGptAuthState;
}

export type ChatGptCredentialOwner = "codex" | "eve";

export interface CodexTokenBrokerOptions extends CodexAppServerOptions {
  readonly appServer?: CodexAppServer;
  readonly store?: ChatGptCredentialStore;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export function createCodexTokenBroker(options: CodexTokenBrokerOptions = {}): CodexTokenBroker {
  const appServer = options.appServer ?? new CodexAppServerClient(options);
  const store = options.store ?? getDefaultChatGptCredentialStore();
  const now = options.now ?? Date.now;
  let credentialOwner: ChatGptCredentialOwner | undefined;
  let currentState: ChatGptAuthState = { kind: "checking" };
  let cached: ChatGptToken | undefined;
  let resolution: { readonly forced: boolean; readonly promise: Promise<ChatGptToken> } | undefined;
  let stateRefresh: Promise<ChatGptAuthState> | undefined;

  return {
    credentialOwner() {
      return credentialOwner;
    },
    getToken(input) {
      return getToken(input.reason);
    },
    refreshState() {
      if (stateRefresh !== undefined) return stateRefresh;
      const promise = refreshAuthState();
      stateRefresh = promise;
      void promise.finally(() => {
        if (stateRefresh === promise) stateRefresh = undefined;
      });
      return promise;
    },
    state() {
      return currentState;
    },
  };

  async function refreshAuthState(): Promise<ChatGptAuthState> {
    if (resolution !== undefined) await resolution.promise.catch(() => undefined);
    if (
      credentialOwner === "codex" &&
      (currentState.kind === "signed-out" || currentState.kind === "reauth-required")
    ) {
      appServer.restart?.();
    } else if (credentialOwner === "eve") {
      // Re-probe at an explicit readiness boundary so a newly installed Codex
      // becomes authoritative without changing owners in the middle of a request.
      credentialOwner = undefined;
    }
    cached = undefined;
    try {
      await getToken("request");
    } catch {
      // The state is the reportable result; callers should not need exception control flow.
    }
    return currentState;
  }

  function getToken(reason: "rejected" | "request"): Promise<ChatGptToken> {
    const forced = reason === "rejected";
    if (!forced && cached !== undefined && isFresh(cached, now())) {
      return Promise.resolve(cached);
    }
    if (resolution !== undefined && (!forced || resolution.forced)) {
      return resolution.promise;
    }

    const pending = resolution?.promise;
    const next =
      pending === undefined
        ? resolveToken(forced)
        : pending.catch(() => undefined).then(() => resolveToken(forced));
    const promise = next.finally(() => {
      if (resolution?.promise === promise) resolution = undefined;
    });
    resolution = { forced, promise };
    return promise;
  }

  async function resolveToken(forceRefresh: boolean): Promise<ChatGptToken> {
    try {
      if (credentialOwner === "eve") return await resolveOwnedToken(forceRefresh);
      try {
        return await resolveAppServerToken(forceRefresh);
      } catch (error) {
        if (!(error instanceof CodexBinaryNotFoundError)) {
          credentialOwner ??= "codex";
          throw error;
        }
        credentialOwner = "eve";
        return await resolveOwnedToken(forceRefresh);
      }
    } catch (error) {
      cached = undefined;
      if (error instanceof ChatGptSignInRequiredError) currentState = { kind: "reauth-required" };
      else if (error instanceof ChatGptSignedOutError) currentState = { kind: "signed-out" };
      else {
        const reason = error instanceof Error ? error.message : String(error);
        currentState = { kind: "unavailable", reason };
      }
      throw error;
    }
  }

  async function resolveAppServerToken(forceRefresh: boolean): Promise<ChatGptToken> {
    let status = await appServer.getAuthStatus({ refreshToken: forceRefresh });
    credentialOwner = "codex";
    if (status.authMethod !== "chatgpt" || status.authToken === undefined) {
      throw forceRefresh
        ? new ChatGptSignInRequiredError()
        : new ChatGptSignedOutError(
            "ChatGPT subscription is not signed in to Codex. Run `codex login` or sign in from /model.",
          );
    }
    let token = tokenFromCodex(status.authToken);
    if (!forceRefresh && !isFresh(token, now())) {
      status = await appServer.getAuthStatus({ refreshToken: true });
      if (status.authMethod !== "chatgpt" || status.authToken === undefined) {
        throw new ChatGptSignInRequiredError();
      }
      token = tokenFromCodex(status.authToken);
    }
    cached = token;
    currentState = readyState(token);
    return token;
  }

  async function resolveOwnedToken(forceRefresh: boolean): Promise<ChatGptToken> {
    let credentials = await store.read();
    if (!credentials) {
      if (forceRefresh) throw new ChatGptSignInRequiredError();
      throw new ChatGptSignedOutError(
        `ChatGPT subscription is not signed in. ${CHATGPT_LOGIN_HINT}`,
      );
    }
    const rejectedToken = tokenFromCredentials(credentials)?.token;
    if (forceRefresh || !isFresh(tokenFromCredentials(credentials), now())) {
      credentials = await store.update(async (current) => {
        if (!current) throw new ChatGptSignInRequiredError();
        if (
          "accessToken" in current &&
          isFresh(tokenFromCredentials(current), now()) &&
          (!forceRefresh || current.accessToken !== rejectedToken)
        ) {
          return current;
        }
        return requestChatGptTokens(
          { grant_type: "refresh_token", refresh_token: current.refreshToken },
          {
            fetch: options.fetch,
            previous: current,
            now,
          },
        );
      });
    }
    const token = tokenFromCredentials(credentials);
    if (!token) throw new Error(`ChatGPT access token is unavailable. ${CHATGPT_LOGIN_HINT}`);
    cached = token;
    currentState = readyState(token);
    return token;
  }
}

let defaultBroker: CodexTokenBroker | undefined;

export function getDefaultCodexTokenBroker(): CodexTokenBroker {
  defaultBroker ??= createCodexTokenBroker();
  return defaultBroker;
}

function tokenFromCredentials(
  credentials: ChatGptCredentials | ChatGptRefreshCredentials,
): ChatGptToken | undefined {
  if (!("accessToken" in credentials)) return undefined;
  return {
    token: credentials.accessToken,
    expiresAt: credentials.expiresAt,
    ...(credentials.accountId && { accountId: credentials.accountId }),
    ...(credentials.accountLabel && { accountLabel: credentials.accountLabel }),
  };
}

function tokenFromCodex(token: string): ChatGptToken {
  const accountId = extractCodexAccountIdFromToken(token);
  const accountLabel = extractCodexAccountLabelFromToken(token);
  const expiresAt = readCodexJwtExpirationMs(token);
  return {
    token,
    ...(accountId !== undefined && { accountId }),
    ...(accountLabel !== undefined && { accountLabel }),
    ...(expiresAt !== undefined && { expiresAt }),
  };
}

class ChatGptSignedOutError extends Error {}

function readyState(token: ChatGptToken): ChatGptAuthState {
  return {
    kind: "ready",
    ...(token.accountLabel !== undefined && { accountLabel: token.accountLabel }),
  };
}

function isFresh(token: ChatGptToken | undefined, now: number): boolean {
  return (
    token !== undefined &&
    (token.expiresAt === undefined || token.expiresAt - TOKEN_REFRESH_WINDOW_MS > now)
  );
}
