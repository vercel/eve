import { createChatGptCredentialStore, type ChatGptCredentialStore } from "./credential-store.js";
import {
  CHATGPT_LOGIN_HINT,
  ChatGptSignInRequiredError,
  requestChatGptTokens,
  type ChatGptCredentials,
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
  getToken(input: { readonly reason: "rejected" | "request" }): Promise<ChatGptToken>;
  refreshState(): Promise<ChatGptAuthState>;
  state(): ChatGptAuthState;
}

export interface CodexTokenBrokerOptions {
  readonly store?: ChatGptCredentialStore;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export function createCodexTokenBroker(options: CodexTokenBrokerOptions = {}): CodexTokenBroker {
  const store = options.store ?? createChatGptCredentialStore();
  const now = options.now ?? Date.now;
  let currentState: ChatGptAuthState = { kind: "checking" };
  let cached: ChatGptToken | undefined;
  let resolution: { readonly forced: boolean; readonly promise: Promise<ChatGptToken> } | undefined;

  return {
    getToken(input) {
      return getToken(input.reason);
    },
    async refreshState() {
      cached = undefined;
      try {
        await getToken("request");
      } catch {
        // The state is the reportable result; callers should not need exception control flow.
      }
      return currentState;
    },
    state() {
      return currentState;
    },
  };

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
      let credentials = await store.read();
      if (!credentials) {
        cached = undefined;
        if (forceRefresh) throw new ChatGptSignInRequiredError();
        currentState = { kind: "signed-out" };
        throw new Error(`ChatGPT subscription is not signed in. ${CHATGPT_LOGIN_HINT}`);
      }
      const rejectedToken = credentials.accessToken;
      if (forceRefresh || !isFresh(tokenFrom(credentials), now())) {
        credentials = await store.update(async (current) => {
          if (!current) throw new ChatGptSignInRequiredError();
          // A different eve process may already have rotated this refresh token.
          if (
            isFresh(tokenFrom(current), now()) &&
            (!forceRefresh || current.accessToken !== rejectedToken)
          )
            return current;
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
      const token = tokenFrom(credentials);
      cached = token;
      currentState = readyState(token);
      return token;
    } catch (error) {
      cached = undefined;
      if (error instanceof ChatGptSignInRequiredError) currentState = { kind: "reauth-required" };
      else if (currentState.kind !== "signed-out") {
        const reason = error instanceof Error ? error.message : String(error);
        currentState = { kind: "unavailable", reason };
      }
      throw error;
    }
  }
}

let defaultBroker: CodexTokenBroker | undefined;

export function getDefaultCodexTokenBroker(): CodexTokenBroker {
  defaultBroker ??= createCodexTokenBroker();
  return defaultBroker;
}

function tokenFrom(credentials: ChatGptCredentials): ChatGptToken {
  return {
    token: credentials.accessToken,
    expiresAt: credentials.expiresAt,
    ...(credentials.accountId && { accountId: credentials.accountId }),
    ...(credentials.accountLabel && { accountLabel: credentials.accountLabel }),
  };
}

function readyState(token: ChatGptToken): ChatGptAuthState {
  return {
    kind: "ready",
    ...(token.accountLabel !== undefined && { accountLabel: token.accountLabel }),
  };
}

function isFresh(token: ChatGptToken, now: number): boolean {
  return token.expiresAt === undefined || token.expiresAt - TOKEN_REFRESH_WINDOW_MS > now;
}
