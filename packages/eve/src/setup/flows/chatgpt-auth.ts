import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import {
  ChatGptInvalidStoredSessionError,
  getDefaultChatGptCredentialStore,
  type ChatGptCredentialStore,
} from "#public/models/openai/chatgpt/credential-store.js";
import {
  CHATGPT_CLIENT_ID,
  CHATGPT_ISSUER,
  requestChatGptTokens,
  readChatGptAuthResponse,
  type ChatGptCredentials,
} from "#public/models/openai/chatgpt/oauth.js";
import {
  getDefaultCodexTokenBroker,
  type CodexTokenBroker,
} from "#public/models/openai/chatgpt/token-broker.js";
import { isErrnoCode, isObject } from "#shared/guards.js";
import { openUrl } from "#setup/primitives/open-url.js";
import { WizardCancelledError } from "#setup/step.js";

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const REDIRECT_URI = "http://localhost:1455/auth/callback";

interface ChatGptAuthOptions {
  readonly signal?: AbortSignal;
  readonly broker?: CodexTokenBroker;
  readonly store?: ChatGptCredentialStore;
  readonly fetch?: typeof fetch;
  readonly open?: (url: string) => void;
  readonly log?: (message: string) => void;
  readonly headless?: boolean;
}

/** Signs in directly with OpenAI; credentials belong to eve, independently of Codex. */
export async function ensureChatGptAuth(options: ChatGptAuthOptions = {}): Promise<void> {
  const broker = options.broker ?? getDefaultCodexTokenBroker();
  const store = options.store ?? getDefaultChatGptCredentialStore();
  options.signal?.throwIfAborted();
  const state = await broker.refreshState();
  if (state.kind === "ready") return;
  try {
    await store.read();
  } catch (error) {
    if (!(error instanceof ChatGptInvalidStoredSessionError)) throw error;
  }
  const controller = new AbortController();
  const cancel = (): void => controller.abort(new WizardCancelledError());
  process.once("SIGINT", cancel);
  const timeout = setTimeout(
    () => controller.abort(new Error("ChatGPT sign-in timed out. Retry from /model.")),
    LOGIN_TIMEOUT_MS,
  );
  const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const open = options.open ?? openUrl;
  try {
    const headless = options.headless ?? Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY);
    const tokens = headless
      ? await deviceLogin({ ...options, signal, log, open })
      : await browserLogin({ ...options, signal, log, open });
    signal.throwIfAborted();
    await store.update(
      async () => {
        signal.throwIfAborted();
        return tokens;
      },
      { replace: true },
    );
    const refreshed = await broker.refreshState();
    if (refreshed.kind !== "ready")
      throw new Error("ChatGPT sign-in could not be verified. Retry from /model.");
    log("ChatGPT subscription connected.");
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timeout);
    process.removeListener("SIGINT", cancel);
  }
}

type LoginOptions = ChatGptAuthOptions & {
  signal: AbortSignal;
  log: (message: string) => void;
  open: (url: string) => void;
};

async function browserLogin(options: LoginOptions): Promise<ChatGptCredentials> {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const authorization = new URL(`${CHATGPT_ISSUER}/oauth/authorize`);
  authorization.search = new URLSearchParams({
    response_type: "code",
    client_id: CHATGPT_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email offline_access",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "eve",
  }).toString();
  const callback = Promise.withResolvers<string>();
  // Attach rejection handling before the listener starts, including immediate cancellation.
  void callback.promise.catch(() => {});
  const server = createServer(
    { requestTimeout: 10_000, headersTimeout: 10_000, maxHeaderSize: 8192 },
    (request, response) => {
      const url = URL.parse(request.url ?? "", REDIRECT_URI);
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      if (request.method !== "GET" || url?.pathname !== "/auth/callback") {
        response.writeHead(404).end("Not found.");
        return;
      }
      if (url.searchParams.get("state") !== state) {
        response
          .writeHead(400)
          .end("This sign-in belongs to another attempt. Return to eve and use its sign-in link.");
        return;
      }
      if (url.searchParams.has("error")) {
        response.writeHead(400).end("ChatGPT sign-in was declined. Return to eve to retry.");
        callback.reject(new Error("ChatGPT sign-in was declined. Retry from /model."));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        response.writeHead(400).end("Missing authorization code.");
        return;
      }
      response.end(
        "Authorization received. Return to eve to finish connecting your ChatGPT subscription.",
      );
      callback.resolve(code);
    },
  );
  server.maxConnections = 10;
  const abort = (): void => callback.reject(options.signal.reason);
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    options.signal.throwIfAborted();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(1455, "127.0.0.1", resolve);
      });
    } catch (error) {
      if (!isErrnoCode(error, "EADDRINUSE"))
        throw new Error(
          "Could not start ChatGPT sign-in on localhost:1455. Free the port and retry from /model.",
        );
      options.log("Local sign-in port is in use. Continuing with a device code.");
      return await deviceLogin(options);
    }
    options.signal.throwIfAborted();
    options.log(
      `Sign in to ChatGPT in your browser:\n${authorization.href}\nWaiting for sign-in. Press Ctrl+C to cancel.`,
    );
    options.open(authorization.href);
    const code = await callback.promise;
    return await requestChatGptTokens(
      {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      },
      options,
    );
  } finally {
    options.signal.removeEventListener("abort", abort);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function deviceLogin(options: LoginOptions): Promise<ChatGptCredentials> {
  const device = await deviceRequest("usercode", { client_id: CHATGPT_CLIENT_ID }, options);
  if (!device.ok)
    throw new Error(
      `ChatGPT device sign-in is unavailable (HTTP ${device.status}). Enable device code authorization in ChatGPT Settings > Security, then retry from /model.`,
    );
  const value = await readChatGptAuthResponse(device);
  if (
    !isObject(value) ||
    typeof value.device_auth_id !== "string" ||
    !value.device_auth_id ||
    typeof value.user_code !== "string" ||
    !/^[A-Z0-9-]{4,32}$/iu.test(value.user_code)
  ) {
    throw new Error("ChatGPT returned an invalid device code. Retry from /model.");
  }
  const interval = Math.min(30, Math.max(1, Number(value.interval) || 5)) * 1000;
  const url = `${CHATGPT_ISSUER}/codex/device`;
  options.log(
    `Open ${url} and enter code: ${value.user_code}\nIf prompted, enable device code authorization in ChatGPT Settings > Security.\nWaiting for sign-in. Press Ctrl+C to cancel.`,
  );
  options.open(url);
  for (;;) {
    await delay(interval + 1000, undefined, { signal: options.signal });
    const response = await deviceRequest(
      "token",
      { device_auth_id: value.device_auth_id, user_code: value.user_code },
      options,
    );
    if (response.status === 403 || response.status === 404) continue;
    if (!response.ok)
      throw new Error(
        `ChatGPT device sign-in failed (HTTP ${response.status}). Retry from /model.`,
      );
    const result = await readChatGptAuthResponse(response);
    if (
      !isObject(result) ||
      typeof result.authorization_code !== "string" ||
      !result.authorization_code ||
      typeof result.code_verifier !== "string" ||
      !result.code_verifier
    )
      throw new Error("ChatGPT returned an invalid device authorization. Retry from /model.");
    return requestChatGptTokens(
      {
        grant_type: "authorization_code",
        code: result.authorization_code,
        code_verifier: result.code_verifier,
        redirect_uri: `${CHATGPT_ISSUER}/deviceauth/callback`,
      },
      options,
    );
  }
}

async function deviceRequest(
  path: "usercode" | "token",
  body: Record<string, string>,
  options: LoginOptions,
): Promise<Response> {
  try {
    return await (options.fetch ?? fetch)(`${CHATGPT_ISSUER}/api/accounts/deviceauth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "eve" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]),
    });
  } catch {
    options.signal.throwIfAborted();
    throw new Error(
      "Could not reach ChatGPT device sign-in. Check your connection and retry from /model.",
    );
  }
}
