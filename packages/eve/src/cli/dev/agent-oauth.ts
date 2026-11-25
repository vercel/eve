import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthTokens,
} from "#compiled/@ai-sdk/mcp/index.js";
import { openUrl } from "#setup/primitives/open-url.js";

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const DISCOVERY_TIMEOUT_MS = 5_000;
const EXPIRY_BUFFER_MS = 60_000;

interface StoredAgentOAuth {
  readonly resource: string;
  client?: OAuthClientInformation;
  redirectUrl?: string;
  tokens?: OAuthTokens;
  expiresAt?: number;
  codeVerifier?: string;
  state?: string;
}

export interface AgentOAuthSession {
  readonly resource: string;
  token(): Promise<string>;
  rejected(): void;
}

export async function signInToAgent(input: {
  readonly headers?: Readonly<Record<string, string>>;
  readonly serverUrl: string;
  readonly signal?: AbortSignal;
  readonly notice: (message: string) => void;
}): Promise<AgentOAuthSession | undefined> {
  const fetchFn = agentFetch(input.serverUrl, input.headers);
  const discovered = await discoverAgentResource(input.serverUrl, fetchFn, input.signal);
  if (discovered === undefined) return undefined;
  const { auth } = await import("#compiled/@ai-sdk/mcp/index.js");
  let store = await readStore(discovered.resource);
  const options = {
    fetchFn,
    resourceMetadataUrl: discovered.metadataUrl,
    serverUrl: discovered.resource,
  };

  let refreshing: Promise<boolean> | undefined;
  const refresh = (): Promise<boolean> =>
    (refreshing ??= (async () => {
      const latest = await readStore(discovered.resource);
      if (hasFreshToken(latest) && latest.tokens?.access_token !== store.tokens?.access_token) {
        store = latest;
        return true;
      }
      if (store.tokens?.refresh_token === undefined) return false;
      try {
        return (await auth(provider(store), options)) === "AUTHORIZED";
      } catch {
        return false;
      }
    })().finally(() => {
      refreshing = undefined;
    }));

  if (!hasFreshToken(store) && !(await refresh())) {
    await login(store, options, input);
  }

  return {
    rejected() {
      store.expiresAt = 0;
    },
    resource: discovered.resource,
    async token() {
      if (!hasFreshToken(store) && !(await refresh())) {
        throw new Error(
          `Your sign-in to ${new URL(discovered.resource).host} expired. Run eve remote connect again to sign in.`,
        );
      }
      return store.tokens!.access_token;
    },
  };
}

async function login(
  store: StoredAgentOAuth,
  options: {
    readonly fetchFn: typeof fetch;
    readonly resourceMetadataUrl: URL;
    readonly serverUrl: string;
  },
  input: { readonly signal?: AbortSignal; readonly notice: (message: string) => void },
): Promise<void> {
  const { auth } = await import("#compiled/@ai-sdk/mcp/index.js");
  const callback = await listenForCallback(store.redirectUrl);
  try {
    if (store.redirectUrl !== callback.redirectUrl) {
      delete store.client;
      store.redirectUrl = callback.redirectUrl;
    }
    delete store.tokens;
    delete store.expiresAt;
    const loginProvider = provider(store, (url) => {
      input.notice(
        `Sign in to ${new URL(options.serverUrl).host} in your browser. If it didn't open, visit:\n${url.href}`,
      );
      openUrl(url.href);
    });
    if ((await auth(loginProvider, options)) === "AUTHORIZED") return;
    const result = await callback.wait(input.signal);
    if (result.state !== store.state) {
      throw new Error("The sign-in response didn't match this sign-in. Run the command again.");
    }
    const authorized = await auth(loginProvider, {
      ...options,
      authorizationCode: result.code,
      callbackState: result.state,
      ...(result.issuer !== undefined && { callbackIssuer: result.issuer }),
    });
    if (authorized !== "AUTHORIZED") throw new Error("The agent didn't accept the sign-in.");
  } finally {
    callback.close();
  }
}

function agentFetch(
  serverUrl: string,
  headers: Readonly<Record<string, string>> | undefined,
): typeof fetch {
  const origin = new URL(serverUrl).origin;
  const extra = Object.entries(headers ?? {}).filter(
    ([name]) => name.toLowerCase() !== "authorization",
  );
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== origin || extra.length === 0) return fetch(input, init);
    const merged = new Headers(input instanceof Request ? input.headers : init?.headers);
    for (const [name, value] of extra) merged.set(name, value);
    return fetch(input, { ...init, headers: merged });
  };
}

async function discoverAgentResource(
  serverUrl: string,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<{ readonly metadataUrl: URL; readonly resource: string } | undefined> {
  const base = new URL(serverUrl);
  const resource = new URL(`${base.pathname.replace(/\/$/, "")}/eve/v1`, base.origin).href;
  const metadataUrl = new URL(
    `/.well-known/oauth-protected-resource${new URL(resource).pathname}`,
    base.origin,
  );
  try {
    const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
    const response = await fetchFn(metadataUrl, {
      redirect: "manual",
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    if (!response.ok) return undefined;
    const metadata = (await response.json()) as {
      readonly authorization_servers?: unknown;
      readonly resource?: unknown;
    };
    const servers = metadata.authorization_servers;
    if (metadata.resource !== resource || !Array.isArray(servers) || servers.length === 0) {
      return undefined;
    }
    return { metadataUrl, resource };
  } catch {
    return undefined;
  }
}

function provider(store: StoredAgentOAuth, redirect?: (url: URL) => void): OAuthClientProvider {
  const save = () => writeStore(store);
  return {
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "eve CLI",
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: [store.redirectUrl ?? "http://127.0.0.1/callback"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    clientInformation: () => store.client,
    codeVerifier: () => {
      if (store.codeVerifier === undefined) throw new Error("No sign-in is in progress.");
      return store.codeVerifier;
    },
    async invalidateCredentials(scope) {
      if (scope === "all" || scope === "client") delete store.client;
      if (scope === "all" || scope === "tokens") {
        delete store.tokens;
        delete store.expiresAt;
      }
      if (scope === "all" || scope === "verifier") delete store.codeVerifier;
      await save();
    },
    isClientInformationDynamicallyRegistered: () => true,
    get redirectUrl() {
      return store.redirectUrl ?? "http://127.0.0.1/callback";
    },
    redirectToAuthorization(url) {
      if (redirect === undefined) throw new Error("Signing in again needs the browser.");
      redirect(url);
    },
    async saveClientInformation(client) {
      store.client = client;
      await save();
    },
    async saveCodeVerifier(verifier) {
      store.codeVerifier = verifier;
      await save();
    },
    async saveState(state) {
      store.state = state;
      await save();
    },
    async saveTokens(tokens) {
      store.tokens = tokens;
      store.expiresAt =
        tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;
      await save();
    },
    state: () => randomBytes(16).toString("base64url"),
    storedState: () => store.state,
    tokens: () => store.tokens,
  };
}

function hasFreshToken(store: StoredAgentOAuth): boolean {
  return (
    store.tokens !== undefined &&
    (store.expiresAt === undefined || store.expiresAt > Date.now() + EXPIRY_BUFFER_MS)
  );
}

interface LoopbackCallback {
  readonly redirectUrl: string;
  wait(signal: AbortSignal | undefined): Promise<{
    readonly code: string;
    readonly issuer?: string;
    readonly state: string;
  }>;
  close(): void;
}

async function listenForCallback(previous: string | undefined): Promise<LoopbackCallback> {
  let settle: ((url: URL) => void) | undefined;
  const received = new Promise<URL>((resolve) => {
    settle = resolve;
  });
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      .end("Signed in. You can close this tab and return to the terminal.");
    settle?.(url);
  });
  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  const previousPort = previous === undefined ? 0 : Number(new URL(previous).port);
  try {
    await listen(previousPort);
  } catch {
    await listen(0);
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Couldn't start the local sign-in callback server.");
  }
  return {
    close: () => server.close(),
    redirectUrl: `http://127.0.0.1:${address.port}/callback`,
    async wait(signal) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for the browser sign-in.")),
          LOGIN_TIMEOUT_MS,
        );
        signal?.addEventListener("abort", () => reject(new Error("Sign-in cancelled.")), {
          once: true,
        });
      });
      try {
        const url = await Promise.race([received, timeout]);
        const error = url.searchParams.get("error");
        if (error !== null) {
          throw new Error(`Sign-in failed: ${url.searchParams.get("error_description") ?? error}`);
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (code === null || state === null) {
          throw new Error("The sign-in response had no authorization code.");
        }
        const issuer = url.searchParams.get("iss") ?? undefined;
        return { code, state, ...(issuer !== undefined && { issuer }) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function storePath(resource: string): string {
  const key = createHash("sha256").update(resource).digest("hex").slice(0, 32);
  return join(homedir(), ".eve", "agent-oauth", `${key}.json`);
}

async function readStore(resource: string): Promise<StoredAgentOAuth> {
  try {
    const stored = JSON.parse(await readFile(storePath(resource), "utf8")) as StoredAgentOAuth;
    if (stored.resource === resource) return stored;
  } catch {}
  return { resource };
}

async function writeStore(store: StoredAgentOAuth): Promise<void> {
  const path = storePath(store.resource);
  await mkdir(join(homedir(), ".eve", "agent-oauth"), { mode: 0o700, recursive: true });
  await rm(`${path}.tmp`, { force: true });
  await writeFile(`${path}.tmp`, JSON.stringify(store), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
