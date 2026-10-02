/**
 * eve-owned multi round-trip request (MRTR) support around `@ai-sdk/mcp`.
 *
 * MCP 2026-07-28 lets a server answer `tools/call` with an
 * `InputRequiredResult` (`resultType: "input_required"`) that carries
 * `inputRequests` and an opaque `requestState`; the client asks its user and
 * retries the call with `inputResponses` and the same `requestState`.
 * `@ai-sdk/mcp` (through at least 2.0.65) throws on that result and offers no
 * way to send `inputResponses`, so eve does both at the fetch boundary it
 * already owns:
 *
 * - {@link runMcpRequestScope} opens a per-call scope, so concurrent calls
 *   on one client never share one.
 * - {@link createMcpInputRequiredFetch} adds the scope's `inputResponses` and
 *   `requestState` to the outgoing request and records an `input_required`
 *   result from the response, JSON or SSE, before the SDK throws.
 * - The scope then returns the recorded result instead of the SDK's error.
 *
 * The wrapper goes away once `@ai-sdk/mcp` supports MRTR itself.
 */

import { ContextContainer, contextStorage, type AlsContext } from "#context/container.js";
import { isObject } from "#shared/guards.js";

/** JSON-RPC methods a server may answer with `input_required` (MCP 2026-07-28). */
const MRTR_METHODS: ReadonlySet<string> = new Set(["prompts/get", "resources/read", "tools/call"]);

// The server is untrusted, and what it sends is stored in session state and
// shown to the user, so every piece of it is capped.
const MAX_REQUEST_STATE_LENGTH = 64 * 1024;
const MAX_INPUT_REQUESTS = 16;
const MAX_INPUT_TEXT_LENGTH = 8 * 1024;

/** One server-initiated request inside `inputRequests`, such as `elicitation/create`. */
export interface McpInputRequest {
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** The parts of an `InputRequiredResult` a client acts on. */
export interface McpInputRequiredResult {
  readonly inputRequests?: Readonly<Record<string, McpInputRequest>>;
  /** Opaque to eve: echoed back unchanged, never inspected, never shown to a model. */
  readonly requestState?: string;
}

/** What a retry adds to the original request's params. */
export interface McpInputRetry {
  readonly inputResponses?: Readonly<Record<string, unknown>>;
  readonly requestState?: string;
}

export type McpScopedOutcome<T> =
  | { readonly status: "completed"; readonly value: T }
  | ({ readonly status: "input_required" } & McpInputRequiredResult);

interface McpRequestScope {
  inputRequired?: McpInputRequiredResult;
  invalid?: string;
  /** Set once the call's first response arrives; the SDK ignores any later one. */
  answered?: boolean;
  readonly retry?: McpInputRetry;
}

/**
 * Scopes by the context view their request runs in. Concurrent tool calls in
 * one step share one EveContext container, so a key on it would let one
 * call's `requestState` leak into a sibling's retry. Each scoped request runs
 * in its own view of that container instead: every read and write goes
 * through to it (the transport caches bearer tokens there), and the view's
 * identity names the scope. No second AsyncLocalStorage is needed.
 */
const scopes = new WeakMap<AlsContext, McpRequestScope>();

function scopedView(parent: AlsContext): AlsContext {
  return new Proxy(parent, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function currentScope(): McpRequestScope | undefined {
  const context = contextStorage.getStore();
  return context === undefined ? undefined : scopes.get(context);
}

/**
 * Runs one MRTR-capable request (`execute`) in its own scope. Returns the
 * server's `input_required` result when it sent one, whether the SDK threw on
 * it or `execute` caught that error (see {@link hasScopedInputRequired}); any
 * other failure is rethrown unchanged.
 */
export async function runMcpRequestScope<T>(input: {
  /** An aborted call is cancelled, never turned into an input request. */
  readonly abortSignal?: AbortSignal;
  readonly execute: () => Promise<T>;
  readonly retry?: McpInputRetry;
}): Promise<McpScopedOutcome<T>> {
  const scope: McpRequestScope = { retry: input.retry };
  const view = scopedView(contextStorage.getStore() ?? new ContextContainer());
  scopes.set(view, scope);
  let value: T;
  try {
    value = await contextStorage.run(view, input.execute);
  } catch (error) {
    if (input.abortSignal?.aborted === true) throw error;
    if (scope.invalid !== undefined) throw new Error(scope.invalid, { cause: error });
    if (scope.inputRequired !== undefined) {
      return { status: "input_required", ...scope.inputRequired };
    }
    throw error;
  }
  if (scope.invalid !== undefined || scope.inputRequired !== undefined) {
    // The SDK's error was swallowed inside `execute` (a trace span); an abort
    // that raced the capture still wins.
    input.abortSignal?.throwIfAborted();
  }
  if (scope.invalid !== undefined) throw new Error(scope.invalid);
  if (scope.inputRequired !== undefined) {
    return { status: "input_required", ...scope.inputRequired };
  }
  return { status: "completed", value };
}

/**
 * Whether the current scope's server answered `input_required` (or a
 * malformed one). Lets code inside the scope, such as a trace span, end
 * cleanly on the SDK's error without seeing `requestState`.
 */
export function hasScopedInputRequired(): boolean {
  const scope = currentScope();
  return scope?.inputRequired !== undefined || scope?.invalid !== undefined;
}

/**
 * Wraps the transport fetch so requests inside a {@link runMcpRequestScope}
 * carry the scope's retry fields and report an `input_required` response.
 * Requests outside a scope pass through, except `initialize` (below).
 */
export function createMcpInputRequiredFetch(fetcher: typeof fetch): typeof fetch {
  return async (request, init) => {
    const message = readJsonRpcMessage(init?.body);
    if (message === undefined) return await fetcher(request, init);

    if (message.method === "initialize") {
      // MRTR exists only in 2026-07-28. A server that negotiates through the
      // legacy handshake would treat these capabilities as permission to send
      // in-flight `elicitation/create` requests, which eve does not answer.
      return await fetcher(request, withBody(init, stripLegacyInputCapabilities(message)));
    }

    const scope = currentScope();
    if (scope === undefined || !MRTR_METHODS.has(message.method)) {
      return await fetcher(request, init);
    }

    const retried = withRetryParams(message, scope.retry);
    const response = await fetcher(request, retried === message ? init : withBody(init, retried));
    return captureInputRequired(response, message.id, scope);
  };
}

/** Client capabilities eve declares so 2026-07-28 servers may send these input modes. */
export const MRTR_CLIENT_CAPABILITIES = {
  elicitation: { form: {}, url: {} },
} as const;

interface JsonRpcMessage extends Record<string, unknown> {
  readonly id?: unknown;
  readonly method: string;
  readonly params?: unknown;
}

function readJsonRpcMessage(body: RequestInit["body"] | undefined): JsonRpcMessage | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(body);
    return isObject(value) && typeof value["method"] === "string"
      ? (value as JsonRpcMessage)
      : undefined;
  } catch {
    return undefined;
  }
}

function withBody(init: RequestInit | undefined, message: JsonRpcMessage): RequestInit {
  return { ...init, body: JSON.stringify(message) };
}

function withRetryParams(
  message: JsonRpcMessage,
  retry: McpInputRetry | undefined,
): JsonRpcMessage {
  if (retry === undefined) return message;
  if (retry.inputResponses === undefined && retry.requestState === undefined) return message;
  const params: Record<string, unknown> = { ...(isObject(message.params) ? message.params : {}) };
  if (retry.inputResponses !== undefined) params["inputResponses"] = retry.inputResponses;
  // The spec forbids sending a `requestState` the server did not return.
  if (retry.requestState !== undefined) params["requestState"] = retry.requestState;
  return { ...message, params };
}

function stripLegacyInputCapabilities(message: JsonRpcMessage): JsonRpcMessage {
  if (!isObject(message.params) || !isObject(message.params["capabilities"])) return message;
  const { elicitation: _elicitation, ...capabilities } = message.params["capabilities"];
  return { ...message, params: { ...message.params, capabilities } };
}

async function captureInputRequired(
  response: Response,
  id: unknown,
  scope: McpRequestScope,
): Promise<Response> {
  if (!response.ok || response.body === null) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const text = await response.clone().text();
    inspectMessage(parseJson(text), id, scope);
    return response;
  }
  if (contentType.includes("text/event-stream")) {
    return new Response(response.body.pipeThrough(sseScanner(id, scope)), {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
  return response;
}

/** Passes SSE bytes through unchanged while scanning `data:` lines for the call's result. */
function sseScanner(id: unknown, scope: McpRequestScope): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let eventType = "";
  const flushEvent = () => {
    // The SDK dispatches only unnamed and `message` events; any other event
    // type never reaches it, so it must not decide the call's outcome either.
    if (data.length > 0 && (eventType === "" || eventType === "message")) {
      inspectMessage(parseJson(data.join("\n")), id, scope);
    }
    data = [];
    eventType = "";
  };
  const scanLines = (final: boolean) => {
    // A trailing CR may be the first half of a CRLF split across chunks; hold
    // it back so the LF that follows does not read as a blank line and end
    // the event early.
    const heldCr = !final && buffer.endsWith("\r");
    const lines = (heldCr ? buffer.slice(0, -1) : buffer).split(/\r\n|\r|\n/u);
    // The last piece has no line ending yet. At end of stream it is an
    // unterminated line, not a blank one, so it never ends an event.
    const rest = lines.pop() ?? "";
    buffer = final ? "" : rest + (heldCr ? "\r" : "");
    for (const line of lines) {
      if (line === "") flushEvent();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
      else if (line.startsWith("event:")) eventType = line.slice(6).replace(/^ /u, "");
    }
    // An event still open at end of stream is discarded, as the SDK's
    // parser does: it never answers the call, so it must not be captured.
    if (final) data = [];
  };
  return new TransformStream({
    transform(chunk, controller) {
      // Scan before passing the chunk on, so the scope holds the result
      // before the SDK reads it and throws.
      buffer += decoder.decode(chunk, { stream: true });
      scanLines(false);
      controller.enqueue(chunk);
    },
    flush() {
      buffer += decoder.decode();
      scanLines(true);
    },
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function inspectMessage(value: unknown, id: unknown, scope: McpRequestScope): void {
  for (const message of Array.isArray(value) ? value : [value]) {
    if (!isObject(message) || message["id"] !== id) continue;
    if (scope.answered === true) continue;
    if (!isObject(message["result"]) && message["error"] === undefined) continue;
    scope.answered = true;
    if (!isObject(message["result"])) continue;
    const result = message["result"];
    if (result["resultType"] !== "input_required") continue;
    const parsed = parseInputRequiredResult(result);
    if (typeof parsed === "string") scope.invalid = parsed;
    else scope.inputRequired = parsed;
  }
}

/** Validates the fields eve acts on; returns an error message for a malformed result. */
export function parseInputRequiredResult(
  result: Readonly<Record<string, unknown>>,
): McpInputRequiredResult | string {
  const { inputRequests, requestState } = result;
  if (requestState !== undefined && typeof requestState !== "string") {
    return "The MCP server returned input_required with a non-string requestState.";
  }
  if (requestState !== undefined && requestState.length > MAX_REQUEST_STATE_LENGTH) {
    return `The MCP server returned input_required with a requestState over ${MAX_REQUEST_STATE_LENGTH} characters.`;
  }
  if (inputRequests === undefined) {
    return requestState === undefined
      ? "The MCP server returned input_required without inputRequests or requestState."
      : { requestState };
  }
  if (!isObject(inputRequests)) {
    return "The MCP server returned input_required with malformed inputRequests.";
  }
  if (Object.keys(inputRequests).length > MAX_INPUT_REQUESTS) {
    return `The MCP server returned input_required with more than ${MAX_INPUT_REQUESTS} inputRequests.`;
  }
  // Request ids are server-chosen keys: a null-prototype map keeps an id like
  // `__proto__` an ordinary entry instead of a prototype write.
  const requests: Record<string, McpInputRequest> = Object.create(null);
  for (const [key, entry] of Object.entries(inputRequests)) {
    if (!isObject(entry) || typeof entry["method"] !== "string") {
      return `The MCP server returned input_required with a malformed request "${key}".`;
    }
    const params = entry["params"];
    if (params !== undefined && !isObject(params)) {
      return `The MCP server returned input_required with malformed params for "${key}".`;
    }
    for (const field of ["message", "url"] as const) {
      const text = params?.[field];
      if (typeof text === "string" && text.length > MAX_INPUT_TEXT_LENGTH) {
        return `The MCP server returned input_required with a ${field} over ${MAX_INPUT_TEXT_LENGTH} characters for "${key}".`;
      }
    }
    requests[key] =
      params === undefined ? { method: entry["method"] } : { method: entry["method"], params };
  }
  return requestState === undefined
    ? { inputRequests: requests }
    : { inputRequests: requests, requestState };
}

/**
 * How eve can answer one `InputRequiredResult`, decided from its
 * `inputRequests` alone (never from `requestState`).
 *
 * - `approval`: one form elicitation whose schema is a single boolean, the
 *   shape eve's `mcpChannel` sends for a tool approval. `approve` is the
 *   `inputResponses` that answers yes.
 * - `sign-in`: only URL-mode elicitations, such as one provider sign-in page
 *   per connection the remote tool needs.
 * - `retry`: no `inputRequests`, only `requestState`; the client may retry.
 * - `unsupported`: anything else (sampling, roots, richer forms, several
 *   requests). eve fails the call rather than guess an answer.
 */
/** One page the user must visit, from a URL-mode elicitation. */
export interface McpSignInLink {
  readonly message?: string;
  readonly url: string;
}

export type McpInputPlan =
  | {
      readonly approve: Readonly<Record<string, unknown>>;
      readonly kind: "approval";
      readonly prompt: string;
    }
  | { readonly kind: "retry" }
  | {
      /** `inputResponses` that tell the server the user finished in the browser. */
      readonly approve: Readonly<Record<string, unknown>>;
      readonly kind: "sign-in";
      readonly links: readonly McpSignInLink[];
    }
  | { readonly kind: "unsupported"; readonly reason: string };

export function planMcpInput(result: McpInputRequiredResult): McpInputPlan {
  const entries = Object.entries(result.inputRequests ?? {});
  if (entries.length === 0) return { kind: "retry" };
  for (const [, request] of entries) {
    if (request.method !== "elicitation/create") {
      return { kind: "unsupported", reason: `it sent a ${request.method} request` };
    }
  }
  if (entries.every(([, request]) => request.params?.["mode"] === "url")) {
    return planSignIn(entries);
  }
  if (entries.length > 1) {
    return { kind: "unsupported", reason: `it asked for ${entries.length} inputs at once` };
  }
  const [key, request] = entries[0]!;
  const params = request.params ?? {};
  const message = typeof params["message"] === "string" ? params["message"] : undefined;
  const mode = params["mode"] ?? "form";
  if (mode !== "form") {
    return { kind: "unsupported", reason: `it sent an elicitation in "${String(mode)}" mode` };
  }
  const property = singleBooleanProperty(params["requestedSchema"]);
  if (property === undefined) {
    return { kind: "unsupported", reason: "it sent a form eve cannot render as an approval" };
  }
  return {
    approve: { [key]: { action: "accept", content: { [property]: true } } },
    kind: "approval",
    prompt: message ?? "Approve this request?",
  };
}

function singleBooleanProperty(schema: unknown): string | undefined {
  if (!isObject(schema) || schema["type"] !== "object" || !isObject(schema["properties"])) {
    return undefined;
  }
  const properties = Object.entries(schema["properties"]);
  if (properties.length !== 1) return undefined;
  const [name, definition] = properties[0]!;
  return isObject(definition) && definition["type"] === "boolean" ? name : undefined;
}

/** Every entry is a URL elicitation: one sign-in prompt, accepted together. */
function planSignIn(entries: readonly (readonly [string, McpInputRequest])[]): McpInputPlan {
  const approve: Record<string, unknown> = Object.create(null);
  const links: McpSignInLink[] = [];
  for (const [key, request] of entries) {
    const url = request.params?.["url"];
    if (typeof url !== "string" || !/^https?:\/\//u.test(url)) {
      return { kind: "unsupported", reason: "it sent a URL elicitation without an http(s) URL" };
    }
    const message = request.params?.["message"];
    links.push(typeof message === "string" ? { message, url } : { url });
    approve[key] = { action: "accept" };
  }
  return { approve, kind: "sign-in", links };
}
