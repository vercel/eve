import {
  extractCodexAccountIdFromToken,
  extractCodexAccountLabelFromToken,
  readCodexJwtExpirationMs,
} from "./auth.js";
import {
  CodexAppServerClient,
  type CodexAppServer,
  type CodexAppServerOptions,
} from "./codex-app-server.js";

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

export interface CodexTokenBrokerOptions extends CodexAppServerOptions {
  readonly appServer?: CodexAppServer;
  readonly now?: () => number;
}

export function createCodexTokenBroker(options: CodexTokenBrokerOptions = {}): CodexTokenBroker {
  const appServer = options.appServer ?? new CodexAppServerClient(options);
  const now = options.now ?? Date.now;
  let currentState: ChatGptAuthState = { kind: "checking" };
  let cached: ChatGptToken | undefined;
  let resolution: { readonly forced: boolean; readonly promise: Promise<ChatGptToken> } | undefined;

  return {
    getToken(input) {
      return getToken(input.reason);
    },
    async refreshState() {
      if (currentState.kind === "signed-out" || currentState.kind === "reauth-required") {
        appServer.restart?.();
      }
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
      const status = await appServer.getAuthStatus({ refreshToken: forceRefresh });
      if (status.authMethod !== "chatgpt" || status.authToken === undefined) {
        cached = undefined;
        currentState = forceRefresh ? { kind: "reauth-required" } : { kind: "signed-out" };
        throw new Error(
          "ChatGPT subscription authentication is unavailable. Run `codex login`, then retry.",
        );
      }
      const token = tokenFrom(status.authToken);
      if (!forceRefresh && !isFresh(token, now())) {
        const refreshed = await appServer.getAuthStatus({ refreshToken: true });
        if (refreshed.authMethod !== "chatgpt" || refreshed.authToken === undefined) {
          cached = undefined;
          currentState = { kind: "reauth-required" };
          throw new Error(
            "ChatGPT subscription authentication could not be refreshed. Run `codex login`, then retry.",
          );
        }
        return accept(refreshed.authToken);
      }
      cached = token;
      currentState = readyState(token);
      return token;
    } catch (error) {
      if (currentState.kind === "checking" || currentState.kind === "ready") {
        const reason = error instanceof Error ? error.message : String(error);
        currentState = { kind: "unavailable", reason };
      }
      throw error;
    }
  }

  function accept(rawToken: string): ChatGptToken {
    const token = tokenFrom(rawToken);
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

function tokenFrom(token: string): ChatGptToken {
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

function readyState(token: ChatGptToken): ChatGptAuthState {
  return {
    kind: "ready",
    ...(token.accountLabel !== undefined && { accountLabel: token.accountLabel }),
  };
}

function isFresh(token: ChatGptToken, now: number): boolean {
  return token.expiresAt === undefined || token.expiresAt - TOKEN_REFRESH_WINDOW_MS > now;
}
