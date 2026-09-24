import { EVE_TASK_PROTOCOL_HEADER } from "#protocol/message.js";
import { EVE_HEALTH_ROUTE_PATH } from "#protocol/routes.js";
import { createRemoteAgentRouteUrl } from "#subagents/remote/route-url.js";
import { TASK_PROTOCOL_MISMATCH, TASK_PROTOCOL_VERSION } from "#tasks/protocol.js";
import { renderRemoteAgentRequestTimedOut, renderTaskProtocolMismatch } from "#tasks/render.js";

/** How long one request to a remote agent may take: the same limit as a callback to the caller. */
export const REMOTE_AGENT_REQUEST_TIMEOUT_MS = 30_000;

/** How long a remote's matching task protocol version is trusted before it is checked again. */
const COMPATIBLE_REMOTE_TTL_MS = 5 * 60_000;

/** Remote base URLs whose health route reported this protocol version, until the stored time. */
const compatibleRemotes = new Map<string, number>();

/**
 * A remote deployment speaks another task protocol version, or reports none
 * because it runs an older eve. Delegation across it would break results,
 * steering, and input requests, so the call fails at once.
 */
export class RemoteTaskProtocolError extends Error {
  /** The version the remote reported; `undefined` when it reported none. */
  readonly remoteVersion: number | undefined;

  constructor(input: { readonly name: string; readonly remoteVersion: number | undefined }) {
    super(renderTaskProtocolMismatch({ ...input, localVersion: TASK_PROTOCOL_VERSION }));
    this.name = "RemoteTaskProtocolError";
    this.remoteVersion = input.remoteVersion;
  }
}

/** A remote agent did not answer one request within its time limit. */
export class RemoteAgentTimeoutError extends Error {
  constructor(input: {
    readonly name: string;
    readonly request: string;
    readonly timeoutMs: number;
  }) {
    super(renderRemoteAgentRequestTimedOut(input));
    this.name = "RemoteAgentTimeoutError";
  }
}

/**
 * Sends one request to a remote agent with a time limit. Redirects are
 * refused, as for callbacks: a remote could otherwise bounce the request,
 * with its credentials, to another address. A request past its limit fails
 * with {@link RemoteAgentTimeoutError}.
 */
export async function fetchRemoteAgent(
  url: string,
  init: Omit<RequestInit, "redirect" | "signal">,
  input: {
    readonly name: string;
    /** What the request asks for, named in the timeout error, such as "create-session". */
    readonly request: string;
    readonly timeoutMs?: number;
  },
): Promise<Response> {
  const timeoutMs = input.timeoutMs ?? REMOTE_AGENT_REQUEST_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, { ...init, redirect: "error", signal });
  } catch (error) {
    if (signal.aborted) {
      throw new RemoteAgentTimeoutError({ name: input.name, request: input.request, timeoutMs });
    }
    throw error;
  }
}

/**
 * Checks that a remote deployment speaks this task protocol version before
 * any work starts there. The health route reports the version in a response
 * header; an older eve reports none, so the call fails before a session
 * exists on the remote. A match is remembered per base URL for a few
 * minutes; a remote that changes version meanwhile still refuses the create
 * request itself.
 */
export async function requireRemoteTaskProtocol(input: {
  readonly headers: Record<string, string>;
  readonly name: string;
  readonly url: string;
}): Promise<void> {
  const now = Date.now();
  if ((compatibleRemotes.get(input.url) ?? 0) > now) return;
  const response = await fetchRemoteAgent(
    createRemoteAgentRouteUrl(input.url, EVE_HEALTH_ROUTE_PATH),
    { headers: input.headers, method: "GET" },
    { name: input.name, request: "health" },
  );
  await response.body?.cancel().catch(() => {});
  if (!response.ok) {
    throw new Error(
      `Remote agent "${input.name}" health check failed with HTTP ${response.status}.`,
    );
  }
  const header = response.headers.get(EVE_TASK_PROTOCOL_HEADER);
  const remoteVersion = header === null || header.trim() === "" ? undefined : Number(header);
  if (remoteVersion !== TASK_PROTOCOL_VERSION) {
    throw new RemoteTaskProtocolError({
      name: input.name,
      remoteVersion:
        remoteVersion !== undefined && Number.isSafeInteger(remoteVersion)
          ? remoteVersion
          : undefined,
    });
  }
  compatibleRemotes.set(input.url, now + COMPATIBLE_REMOTE_TTL_MS);
}

/** Forgets every remembered remote protocol check; tests start from a clean process. */
export function resetRemoteTaskProtocolChecks(): void {
  compatibleRemotes.clear();
}

/** The protocol version a response body reports, when it reports a valid one. */
export function readTaskProtocol(body: unknown): number | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const value = Reflect.get(body, "taskProtocol");
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/** Throws unless a remote's accepted response reports this deployment's protocol version. */
export function requireTaskProtocol(input: {
  readonly body: unknown;
  readonly name: string;
}): void {
  const remoteVersion = readTaskProtocol(input.body);
  if (remoteVersion !== TASK_PROTOCOL_VERSION) {
    throw new RemoteTaskProtocolError({ name: input.name, remoteVersion });
  }
}

/** The protocol error a remote's rejection carries, if it rejected the request's version. */
export function readTaskProtocolRejection(input: {
  readonly body: unknown;
  readonly name: string;
  readonly status: number;
}): RemoteTaskProtocolError | undefined {
  if (input.status !== 409 || input.body === null || typeof input.body !== "object") {
    return undefined;
  }
  if (Reflect.get(input.body, "code") !== TASK_PROTOCOL_MISMATCH) return undefined;
  return new RemoteTaskProtocolError({
    name: input.name,
    remoteVersion: readTaskProtocol(input.body),
  });
}

/**
 * Whether a caller refused a callback because it speaks another task
 * protocol version. Retrying cannot change that. Reads the response body.
 */
export async function isTaskProtocolRefusal(response: Response): Promise<boolean> {
  if (response.status !== 409) return false;
  const body = await readJsonBody(response);
  return (
    body !== null &&
    typeof body === "object" &&
    Reflect.get(body, "code") === TASK_PROTOCOL_MISMATCH
  );
}

/** Reads a response body as JSON, or `undefined` when it has none. */
export async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
