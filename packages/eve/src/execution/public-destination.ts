import type { Dispatcher1Wrapper } from "undici";

import { loadAddressGuardedDispatcher } from "#runtime-env/public-dispatcher.js";
import { isBlockedDestinationHost } from "#shared/network-address.js";

export class UnsafeDestinationError extends Error {
  constructor(
    message = "URL must not target localhost, private, link-local, or reserved IP addresses.",
  ) {
    super(message);
    this.name = "UnsafeDestinationError";
  }
}

export class UnguardedRuntimeError extends UnsafeDestinationError {
  constructor() {
    super(
      "This runtime cannot guard outbound requests against private and internal addresses, so eve refuses requests to URLs that users or models supply.",
    );
    this.name = "UnguardedRuntimeError";
  }
}

export interface PublicDestinationPolicy {
  readonly allowLoopback: boolean;
}

interface DispatcherHandler {
  onResponseError?(controller: undefined, error: Error): void;
  onError?(error: Error): void;
}

interface ProbeDispatcher {
  dispatch(options: unknown, handler: DispatcherHandler): boolean;
  close(): Promise<void>;
  destroy(): Promise<void>;
}

type DispatcherRequestInit = Omit<RequestInit, "dispatcher"> & {
  readonly dispatcher: Dispatcher1Wrapper | ProbeDispatcher;
};

export function assertPublicHostname(hostname: string, policy: PublicDestinationPolicy): void {
  if (isBlockedDestinationHost(hostname, policy)) {
    throw new UnsafeDestinationError();
  }
}

export const DISPATCHER_PROBE_URL = "http://dispatcher-probe.invalid/";

const dispatcherSupport = new WeakMap<typeof fetch, Promise<boolean>>();

export async function createPublicDispatcher(
  policy: PublicDestinationPolicy,
): Promise<Dispatcher1Wrapper> {
  const createDispatcher = await loadAddressGuardedDispatcher({
    isBlocked: (address) => isBlockedDestinationHost(address, policy),
    blocked: () => new UnsafeDestinationError(),
  });
  if (createDispatcher === undefined) throw new UnguardedRuntimeError();
  let supported = dispatcherSupport.get(fetch);
  if (supported === undefined) {
    supported = fetchHonorsDispatcher();
    dispatcherSupport.set(fetch, supported);
  }
  if (!(await supported)) throw new UnguardedRuntimeError();
  return createDispatcher();
}

async function fetchHonorsDispatcher(): Promise<boolean> {
  const probe = new Error("eve dispatcher probe");
  const dispatcher: ProbeDispatcher = {
    dispatch(_options, handler) {
      queueMicrotask(() => {
        if (handler.onResponseError !== undefined) handler.onResponseError(undefined, probe);
        else handler.onError?.(probe);
      });
      return true;
    },
    close: async () => {},
    destroy: async () => {},
  };
  try {
    await fetchWithDispatcher(DISPATCHER_PROBE_URL, { dispatcher });
    return false;
  } catch (error) {
    return error instanceof Error && error.cause === probe;
  }
}

export function findUnsafeDestinationError(error: unknown): UnsafeDestinationError | undefined {
  if (error instanceof UnsafeDestinationError) return error;
  return error instanceof Error && error.cause instanceof UnsafeDestinationError
    ? error.cause
    : undefined;
}

export function fetchWithDispatcher(url: string | URL, init: DispatcherRequestInit) {
  const fetchWithUndici = fetch as typeof fetch &
    ((input: string | URL, init: DispatcherRequestInit) => Promise<Response>);
  return fetchWithUndici(url, init);
}

export async function readBoundedResponse(
  response: Response,
  maxResponseSize: number,
): Promise<Response> {
  const declaredLength = parseContentLength(response.headers.get("content-length"));

  if (declaredLength !== undefined && declaredLength > maxResponseSize) {
    await cancelResponseBody(response);
    throw new ResponseTooLargeError(maxResponseSize);
  }

  const body = await readBoundedBody(response, maxResponseSize);
  const responseBody = body.byteLength === 0 ? null : Uint8Array.from(body).buffer;

  return new Response(responseBody, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function readBoundedBody(response: Response, maxResponseSize: number): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      byteLength += value.byteLength;
      if (byteLength > maxResponseSize) {
        await reader.cancel();
        throw new ResponseTooLargeError(maxResponseSize);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {}
}

export class ResponseTooLargeError extends Error {
  constructor(maxResponseSize: number) {
    super(`Response too large (exceeds ${maxResponseSize} bytes).`);
    this.name = "ResponseTooLargeError";
  }
}
