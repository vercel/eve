import { TASK_PROTOCOL_MISMATCH, TASK_PROTOCOL_VERSION } from "#tasks/protocol.js";
import { renderTaskProtocolMismatch } from "#tasks/render.js";

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

/** Reads a response body as JSON, or `undefined` when it has none. */
export async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
