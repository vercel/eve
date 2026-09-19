import { createLogger } from "#internal/logging.js";
import type { OutboundAuthFn } from "#public/agents/auth.js";
import { isObject } from "#shared/guards.js";

const log = createLogger("execution.session-callback");
const SESSION_CALLBACK_TIMEOUT_MS = 30_000;
const VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER = "x-vercel-trusted-oidc-idp-token";
const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");
const SESSION_CALLBACK_AUTH = Symbol.for("eve.session-callback-auth");

// The global symbol makes the registration visible to both Nitro-inlined and
// disk-imported eve modules, which otherwise hold separate module instances.
const callbackAuthRegistry = globalThis as typeof globalThis & {
  [SESSION_CALLBACK_AUTH]?: OutboundAuthFn;
};

/** Registers the outbound auth used for callbacks this deployment sends to remote parents. */
export function setSessionCallbackAuth(fn: OutboundAuthFn | undefined): void {
  callbackAuthRegistry[SESSION_CALLBACK_AUTH] = fn;
}

/** Posts one framework callback payload with the shared callback transport policy. */
export async function postSessionCallbackRequest(input: {
  readonly body: unknown;
  /** Set false when the caller owns failure logging, such as best-effort activity. */
  readonly logFailures?: boolean;
  readonly timeoutMs?: number;
  readonly url: string;
}): Promise<Response> {
  const timeoutMs = input.timeoutMs ?? SESSION_CALLBACK_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(input.url, {
      body: JSON.stringify(input.body),
      headers: await resolveSessionCallbackHeaders(input.url),
      method: "POST",
      // Do not follow redirects: a validated callback host could otherwise
      // 3xx-bounce the framework to an internal/metadata address after the
      // path/token check has already passed.
      redirect: "error",
      signal,
    });
  } catch (error) {
    // Fetch errors can contain the capability URL or credentials in their
    // cause chain. Log a safe summary, but preserve the original rejection.
    if (input.logFailures !== false) {
      log.error("callback delivery failed", {
        ...callbackLogFields(input),
        failure: signal.aborted ? "timeout" : "transport",
        timeoutMs,
        error: new Error("Callback request failed before receiving a response."),
      });
    }
    throw error;
  }
  if (!response.ok && input.logFailures !== false) {
    log.error("callback delivery failed", {
      ...callbackLogFields(input),
      failure: "http",
      statusCode: response.status,
      error: new Error(`Callback request failed with HTTP ${response.status}.`),
    });
  }
  return response;
}

function callbackLogFields(input: { readonly body: unknown; readonly url: string }) {
  const url = URL.parse(input.url);
  const route = url?.pathname.match(/^(.*?\/(?:callback|activity))\//)?.[1];
  const fields: Record<string, string | number | undefined> = {
    callbackOrigin: url?.origin,
    callbackPath: route === undefined ? "[redacted]" : `${route}/[redacted]`,
  };
  if (isObject(input.body)) {
    for (const key of [
      "kind",
      "callId",
      "taskId",
      "sessionId",
      "childSessionId",
      "subagentName",
      "updateEpoch",
    ]) {
      if (typeof input.body[key] === "string") fields[key] = input.body[key];
    }
    if (typeof input.body.updateIndex === "number") fields.updateIndex = input.body.updateIndex;
  }
  return fields;
}

async function resolveSessionCallbackHeaders(urlValue: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // Credentials never travel over plaintext.
  if (URL.parse(urlValue)?.protocol !== "https:") return headers;
  // The URL was nominated by a caller that passed the channel's
  // `trustedForwarders` policy (see `authorizeRemoteCallback`), so this
  // deployment's credentials only go to an explicitly trusted parent.
  const auth = callbackAuthRegistry[SESSION_CALLBACK_AUTH] ?? defaultSessionCallbackAuth;
  try {
    return { ...(await auth()).headers, ...headers };
  } catch {
    log.error("callback auth failed; sending without credentials", {
      error: new Error("Callback auth function threw."),
    });
    return headers;
  }
}

const defaultSessionCallbackAuth: OutboundAuthFn = async () => {
  const token = process.env.VERCEL === "1" ? readAmbientVercelOidcToken() : undefined;
  const headers: Record<string, string> = {};
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
    headers[VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER] = token;
  }
  return { headers };
};

function readAmbientVercelOidcToken(): string | undefined {
  const requestContext = (
    globalThis as typeof globalThis & {
      [key: symbol]: { get?(): { headers?: Record<string, string> } } | undefined;
    }
  )[VERCEL_REQUEST_CONTEXT];
  const token =
    requestContext?.get?.().headers?.["x-vercel-oidc-token"] ?? process.env.VERCEL_OIDC_TOKEN;
  const trimmed = token?.trim();
  return trimmed === "" ? undefined : trimmed;
}
