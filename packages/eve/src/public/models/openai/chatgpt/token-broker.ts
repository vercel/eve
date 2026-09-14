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
import { ChatGptSignInRequiredError } from "./oauth.js";
import { ChatGptSignedOutError, isChatGptTokenFresh, type ChatGptToken } from "./token.js";

export type ChatGptAuthState =
  | { readonly kind: "checking" }
  | {
      readonly accountLabel?: string;
      readonly kind: "ready";
    }
  | { readonly kind: "signed-out" }
  | { readonly kind: "reauth-required" }
  | { readonly kind: "unavailable"; readonly reason: string };

export type { ChatGptToken } from "./token.js";

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
    if (!forced && cached !== undefined && isChatGptTokenFresh(cached, now())) {
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
      let token: ChatGptToken;
      if (credentialOwner === "eve") {
        token = await store.resolveToken({ forceRefresh, fetch: options.fetch, now });
      } else {
        try {
          token = await appServer.resolveToken({ forceRefresh, now });
          credentialOwner = "codex";
        } catch (error) {
          if (!(error instanceof CodexBinaryNotFoundError)) {
            credentialOwner ??= "codex";
            throw error;
          }
          credentialOwner = "eve";
          token = await store.resolveToken({ forceRefresh, fetch: options.fetch, now });
        }
      }
      cached = token;
      currentState = readyState(token);
      return token;
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
}

let defaultBroker: CodexTokenBroker | undefined;

export function getDefaultCodexTokenBroker(): CodexTokenBroker {
  defaultBroker ??= createCodexTokenBroker();
  return defaultBroker;
}

function readyState(token: ChatGptToken): ChatGptAuthState {
  return {
    kind: "ready",
    ...(token.accountLabel !== undefined && { accountLabel: token.accountLabel }),
  };
}
