import { encodeWireValue } from "#compute/codec.js";
import { ComputeError } from "#compute/errors.js";
import type {
  CellAddress,
  CellView,
  EventRecord,
  Failure,
  MessageReceipt,
  NamespaceView,
  ReadEventsOptions,
  SendOptions,
  VersionedInput,
} from "#compute/protocol.js";
import {
  assertDefinitionId,
  assertLocalKey,
  assertUuid,
  assertVersion,
  parseCounter,
} from "#compute/validation.js";

/** Configuration for a namespace-scoped compute client. */
export interface ComputeClientOptions {
  endpoint: string;
  fetch?: typeof globalThis.fetch;
  namespaceId: string;
  token: string;
}

async function responseFailure(response: Response): Promise<ComputeError> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return new ComputeError("INTERNAL", `Compute request failed with HTTP ${response.status}.`);
  }
  if (
    value !== null &&
    typeof value === "object" &&
    "error" in value &&
    value.error !== null &&
    typeof value.error === "object" &&
    "code" in value.error &&
    "message" in value.error &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  ) {
    const failure = value.error as Failure;
    return new ComputeError(failure.code, failure.message);
  }
  return new ComputeError("INTERNAL", `Compute request failed with HTTP ${response.status}.`);
}

/** HTTP client for durable keyed-cell admission and inspection. */
export class ComputeClient {
  readonly #endpoint: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #namespaceId: string;
  readonly #token: string;

  constructor(options: ComputeClientOptions) {
    assertUuid(options.namespaceId, "namespaceId");
    if (typeof options.token !== "string" || options.token.length === 0) {
      throw new ComputeError("INVALID_INPUT", "Compute token is required.");
    }
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint);
    } catch {
      throw new ComputeError("INVALID_INPUT", "Compute endpoint must be an absolute URL.");
    }
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      throw new ComputeError("INVALID_INPUT", "Compute endpoint must use HTTP or HTTPS.");
    }
    if (endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
      throw new ComputeError("INVALID_INPUT", "Compute endpoint must be an origin without a path.");
    }
    this.#endpoint = endpoint.toString().replace(/\/+$/u, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#namespaceId = options.namespaceId;
    this.#token = options.token;
  }

  async #request(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${this.#token}`);
    const response = await this.#fetch(
      `${this.#endpoint}/compute/v1/namespaces/${encodeURIComponent(this.#namespaceId)}${path}`,
      {
        ...init,
        headers,
      },
    );
    if (!response.ok) throw await responseFailure(response);
    return response;
  }

  /** Durably admits one versioned message and returns after its receipt commits. */
  async send<T>(
    address: Omit<CellAddress, "namespaceId">,
    message: VersionedInput<T>,
    options: SendOptions,
  ): Promise<MessageReceipt> {
    assertDefinitionId(address.definition, "address.definition");
    assertLocalKey(address.key, "address.key");
    assertVersion(message.version, "message.version");
    assertLocalKey(options.idempotencyKey, "idempotencyKey");
    const body = JSON.stringify({
      address,
      message: {
        version: message.version,
        value: encodeWireValue(message.value),
      },
      idempotencyKey: options.idempotencyKey,
    });
    const response = await this.#request("/cells:send", {
      body,
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return (await response.json()) as MessageReceipt;
  }

  /** Reads the current persisted cell state without running application code. */
  async readState(cellId: string): Promise<CellView> {
    assertUuid(cellId, "cellId");
    return (await (await this.#request(`/cells/${encodeURIComponent(cellId)}`)).json()) as CellView;
  }

  /** Reads the durable status of one admitted message. */
  async readReceipt(messageId: string): Promise<MessageReceipt> {
    assertUuid(messageId, "messageId");
    return (await (
      await this.#request(`/messages/${encodeURIComponent(messageId)}`)
    ).json()) as MessageReceipt;
  }

  /** Reads a finite page of persisted cell events. */
  async readEvents(cellId: string, options: ReadEventsOptions = {}): Promise<EventRecord[]> {
    assertUuid(cellId, "cellId");
    if (options.after !== undefined) parseCounter(options.after, "after");
    const query = new URLSearchParams();
    if (options.after !== undefined) query.set("after", options.after);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.follow !== undefined) query.set("follow", String(options.follow));
    const response = await this.#request(`/cells/${encodeURIComponent(cellId)}/events?${query}`);
    const text = await response.text();
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as EventRecord);
  }

  /** Reads namespace deployment, admission, usage, and quota state. */
  async readNamespace(): Promise<NamespaceView> {
    return (await (await this.#request("/")).json()) as NamespaceView;
  }
}
