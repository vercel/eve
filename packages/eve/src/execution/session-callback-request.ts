import { NonRetryableError } from "#shared/run-errors.js";
import {
  assertPublicHostname,
  createPublicDispatcher,
  fetchWithDispatcher,
  findUnsafeDestinationError,
  readBoundedResponse,
  UnsafeDestinationError,
} from "#execution/public-destination.js";
import { isLocalDevelopmentServer } from "#internal/application/dev-environment.js";
import { createLogger } from "#internal/logging.js";
import { platformContext } from "#platform/context.js";
import { isObject } from "#shared/guards.js";

const log = createLogger("execution.session-callback");
const SESSION_CALLBACK_TIMEOUT_MS = 30_000;
const MAX_CALLBACK_RESPONSE_BYTES = 64 * 1024;

export async function postSessionCallbackRequest(input: {
  readonly body: unknown;
  readonly logFailures?: boolean;
  readonly timeoutMs?: number;
  readonly url: string;
}): Promise<Response> {
  const timeoutMs = input.timeoutMs ?? SESSION_CALLBACK_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const headers = await resolveSessionCallbackHeaders(input.url);
  let response: Response;
  try {
    response = await requestCallback(input.url, {
      body: JSON.stringify(input.body),
      headers,
      signal,
    });
  } catch (error) {
    const blocked = findUnsafeDestinationError(error);
    if (blocked !== undefined) {
      if (input.logFailures !== false) {
        log.error("callback delivery failed", {
          ...callbackLogFields(input),
          failure: "blocked-destination",
          error: new Error(blocked.message),
        });
      }
      throw new NonRetryableError(`Callback delivery refused: ${blocked.message}`);
    }
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

async function requestCallback(
  urlText: string,
  init: {
    readonly body: string;
    readonly headers: Record<string, string>;
    readonly signal: AbortSignal;
  },
): Promise<Response> {
  const url = new URL(urlText);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeDestinationError("Callback URL must use http or https.");
  }
  const policy = { allowLoopback: isLocalDevelopmentServer() };
  assertPublicHostname(url.hostname, policy);
  const dispatcher = await createPublicDispatcher(policy);
  try {
    const response = await fetchWithDispatcher(urlText, {
      ...init,
      dispatcher,
      method: "POST",
      redirect: "error",
    });
    return await readBoundedResponse(response, MAX_CALLBACK_RESPONSE_BYTES);
  } finally {
    await dispatcher.close();
  }
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
  return {
    "content-type": "application/json",
    ...platformContext().identity.callbackHeaders(urlValue, (url) =>
      configuredCallbackOrigins().some((matches) => matches(url)),
    ),
  };
}

function configuredCallbackOrigins(): Array<(url: URL) => boolean> {
  const configured = process.env.EVE_CALLBACK_TRUSTED_ORIGINS?.trim();
  if (!configured) return [];
  return configured.split(",").map((entry) => {
    const url = URL.parse(entry.trim());
    if (
      url === null ||
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw invalidCallbackOriginsError();
    }
    if (!url.hostname.includes("*")) return (target) => target.origin === url.origin;

    const suffix = url.hostname.slice(2);
    if (
      !url.hostname.startsWith("*.") ||
      suffix.includes("*") ||
      suffix.endsWith(".") ||
      suffix.split(".").length < 2 ||
      suffix === "vercel.app"
    ) {
      throw invalidCallbackOriginsError();
    }
    return (target) => {
      const label = target.hostname.slice(0, -(suffix.length + 1));
      return (
        target.port === url.port &&
        target.hostname.endsWith(`.${suffix}`) &&
        label !== "" &&
        !label.includes(".")
      );
    };
  });
}

function invalidCallbackOriginsError(): NonRetryableError {
  return new NonRetryableError(
    "EVE_CALLBACK_TRUSTED_ORIGINS must be a comma-separated list of HTTPS origins without credentials, paths, queries, or fragments. A leading `*.` label (e.g. `https://*.preview.example.com`) matches exactly one subdomain label and needs at least two labels after it; `*.vercel.app` and trailing dots are not allowed.",
  );
}
