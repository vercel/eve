/**
 * A strict test double over the Slack Web API.
 *
 * The double owns the `api.fetch` seam and nothing else. It holds no
 * workspace, allocates no timestamps, and models no Slack behavior. A
 * test declares which methods may be called and what they answer, then
 * asserts against the recorded calls.
 *
 * A method nobody stubbed fails the request, naming the method and
 * listing what is stubbed, so a Slack call added to the channel fails
 * every test that reaches it until those tests declare it.
 *
 * Failures are recorded as {@link MockSlack.violations} as well as
 * rejecting the `fetch`, because production paths such as thread refresh
 * and typing indicators swallow transport errors. Assert with
 * {@link MockSlack.assertNoViolations}.
 *
 * Stub method names and response shapes are checked against
 * {@link SlackApiContract}, which catches a typo'd method, a stub
 * returning the wrong shape, and a production call with no contract
 * entry.
 *
 * ```ts
 * const slack = mockSlack();
 * slack.allow("chat.postMessage").andReturn({ ok: true, channel: "C01", ts: "1700.1" });
 *
 * await thread.post("hi");
 *
 * expect(slack.bodyOf("chat.postMessage")).toMatchObject({ markdown_text: "hi" });
 * ```
 */

import type {
  SlackApiMethod,
  SlackApiRequest,
  SlackApiResponseFor,
  SlackTransportLeg,
} from "#internal/testing/mocks/slack-api-contract.js";
import { decodeSlackApiBody } from "#public/channels/slack/api-encoding.js";

/** Slack's own Web API base, used when the test does not override it. */
const DEFAULT_URL = "https://slack.com/api/";

/**
 * Methods eve sends as JSON, because Slack accepts nothing else for
 * them. Slack's JSON support is partial, so every other method must
 * arrive form-encoded.
 */
const JSON_METHODS = new Set<string>(["views.open", "chat.update"]);

/** One request observed by the double, in call order. */
export interface MockSlackCall {
  /** The Slack method name, or a synthetic {@link SlackTransportLeg}. */
  readonly method: string;
  readonly url: string;
  /** Request body decoded exactly as production encoded it. */
  readonly body: unknown;
  readonly contentType: string | null;
}

/** HTTP-level failure, as distinct from a Slack `{ ok: false }` envelope. */
export interface MockSlackHttpFailure {
  readonly status: number;
  /** Emitted as a `Retry-After` header, for the 429 back-off paths. */
  readonly retryAfter?: number | string;
  /** Slack envelope carried in the failing body. Defaults to `{ ok: false }`. */
  readonly body?: Readonly<Record<string, unknown>>;
}

/** Fluent declaration of what one Slack method does when it is called. */
export interface MockSlackStub<M extends SlackApiMethod> {
  /** Answer every matching call with this response. */
  andReturn(response: SlackApiResponseFor<M>): MockSlackStub<M>;
  /**
   * Answer successive calls with successive responses. A call past the
   * end of the list fails, naming the method.
   */
  andReturnEach(responses: readonly SlackApiResponseFor<M>[]): MockSlackStub<M>;
  /**
   * Answer with a response {@link SlackApiContract} does not describe,
   * for pinning what eve does when Slack breaks its own shape — a
   * `chat.postMessage` that comes back with no `ts`, say. The response
   * is not shape-checked; {@link andReturn} is the checked form.
   */
  andReturnRaw(response: Readonly<Record<string, unknown>>): MockSlackStub<M>;
  /** Compute the response from the decoded request body. */
  andRespond(respond: (body: SlackApiRequest<M>) => SlackApiResponseFor<M>): MockSlackStub<M>;
  /**
   * Constrain which calls this stub answers. A call to the method that
   * does not satisfy the constraint fails at the call.
   *
   * The expectation is in {@link SlackApiRequest} — the wire shape — so
   * a form-encoded number is written as the string it arrives as:
   * `.with({ limit: "50" })`, not `.with({ limit: 50 })`.
   *
   * One constraint per method: a second `with` replaces the first. To
   * answer two argument cases differently, read the body in
   * {@link andRespond}.
   */
  with(expected: Partial<SlackApiRequest<M>>): MockSlackStub<M>;
  /** Answer with a Slack-level `{ ok: false, error }` envelope. */
  andFail(error: string): MockSlackStub<M>;
  /** Fail the transport, which production surfaces as a thrown `SlackApiError`. */
  andFailHttp(failure: MockSlackHttpFailure): MockSlackStub<M>;
}

export interface MockSlack {
  /** Drop-in fetch for the channel's `api: { fetch }`. */
  readonly fetch: typeof globalThis.fetch;
  /** Normalized base URL the double answers on. */
  readonly url: string;
  /** Ordered log of every request observed. */
  readonly calls: readonly MockSlackCall[];
  /** The subset of {@link calls} for one method, in call order. */
  callsTo(method: string): readonly MockSlackCall[];
  /**
   * Decoded body of one call to a method — the nth, defaulting to the
   * first. Throws naming the method, and listing the methods that were
   * called, when there was no such call.
   *
   * Typed from {@link SlackApiContract}, so an assertion that reads a
   * field the method does not carry is a compile error.
   */
  bodyOf<M extends SlackApiMethod>(method: M, index?: number): SlackApiRequest<M>;
  /** Methods actually called, in first-call order. */
  observedMethods(): readonly string[];
  /** Declare what one method does. Unstubbed methods fail loudly. */
  allow<M extends SlackApiMethod>(method: M): MockSlackStub<M>;
  /**
   * Declare a method that sits outside {@link SlackApiContract}.
   *
   * `ctx.slack.request(...)` is a documented escape hatch that can reach
   * any Slack method, including ones the channel itself never drives, so
   * the contract cannot cover them without entries for the whole Web
   * API. Neither the method name nor the response shape is checked here,
   * and the method is invisible to the contract parity check. Use
   * {@link allow} for anything the channel itself calls.
   */
  allowUncheckedMethod(method: string, response: Readonly<Record<string, unknown>>): void;
  /**
   * Queues a one-shot Slack-level `{ ok: false, error }` ahead of
   * whatever the method is stubbed to return. The method still has to
   * be stubbed: a queued failure says how the next call fails, not that
   * the call was expected at all.
   *
   * Web API methods only. The upload and download legs return bytes,
   * not a Slack envelope, so they have no `{ ok: false }` to serve —
   * use {@link failNextHttp} for those.
   */
  failNext(method: SlackApiMethod, error: string): void;
  /**
   * Queues a one-shot HTTP failure. It is served before any
   * {@link failNext} for the same method, because the request never
   * reaches Slack's method dispatch.
   *
   * Accepts the two transport legs as well as a Web API method: an
   * upload POST and a `url_private` download are ordinary HTTP requests
   * that Slack can rate limit.
   */
  failNextHttp(method: SlackApiMethod | SlackTransportLeg, failure: MockSlackHttpFailure): void;
  /** The URL `files.getUploadURLExternal` should hand out for a file id. */
  uploadUrl(fileId: string): string;
  /** A `url_private` on this double's origin, for the download leg. */
  downloadUrl(path: string): string;
  /** Bytes received by the upload leg, in upload order. */
  uploadedBytes(): readonly Uint8Array[];
  /** Serve one authenticated `url_private` download with these bytes. */
  allowDownload(bytes: Uint8Array): void;
  /**
   * Fails the request in flight and records a violation, for a stub
   * whose `andRespond` has decided the call itself is wrong — an
   * unexpected channel id, more uploads than the test declared ids for.
   *
   * The recorded violation is what makes such a failure visible. A bare
   * `throw` only rejects the `fetch`, and production swallows that on
   * several paths: a failing `conversations.info` fails closed onto the
   * "treat as private" branch, leaving the test green on a branch it is
   * not asserting about.
   */
  reject(message: string): never;
  /**
   * Protocol violations: an unstubbed method, an unsatisfied `with`
   * constraint, a call that was not form-encoded on a form-only method,
   * one carrying no bearer token, or a {@link reject} from a stub. Each
   * also rejects the `fetch`.
   */
  readonly violations: readonly string[];
  /** Throws when the double rejected any request. */
  assertNoViolations(): void;
}

export interface MockSlackOptions {
  /**
   * Base the double answers on. Defaults to Slack's own host so a test
   * can stub the global `fetch` when covering the default-transport
   * path. Normalized to a trailing slash, matching `resolveSlackApiUrl`.
   */
  readonly url?: string;
}

interface StubState {
  responses: unknown[];
  sequence: boolean;
  respond?: (body: Record<string, unknown>) => unknown;
  constraint?: Record<string, unknown>;
  failure?: string;
  httpFailure?: MockSlackHttpFailure;
}

export function mockSlack(options: MockSlackOptions = {}): MockSlack {
  const base = normalizeUrl(options.url ?? DEFAULT_URL);
  const origin = new URL(base).origin;

  const calls: MockSlackCall[] = [];
  const violations: string[] = [];
  const stubs = new Map<string, StubState>();
  const failNextQueue = new Map<string, string[]>();
  const failNextHttpQueue = new Map<string, MockSlackHttpFailure[]>();
  const uploads: Uint8Array[] = [];
  const downloads: Uint8Array[] = [];

  function reject(message: string): never {
    violations.push(message);
    throw new Error(`mockSlack: ${message}`);
  }

  function takeQueued<T>(queue: Map<string, T[]>, method: string): T | undefined {
    const pending = queue.get(method);
    if (pending === undefined || pending.length === 0) return undefined;
    return pending.shift();
  }

  function describeStubbed(): string {
    const declared = [...stubs.keys()].sort();
    return declared.length === 0
      ? "no methods are stubbed on this double"
      : `stubbed methods: ${declared.join(", ")}`;
  }

  /**
   * Resolves the stub a call is answered from, rejecting a method nobody
   * declared or a call its constraint refuses.
   *
   * Runs before the one-shot `failNext` queues, so a queued failure for
   * an undeclared method does not answer with a well-formed Slack
   * envelope.
   */
  function requireStub(method: string, body: Record<string, unknown>): StubState {
    const stub = stubs.get(method);
    if (stub === undefined) {
      reject(
        `${method} was called but never stubbed. ` +
          `Declare it with slack.allow("${method}").andReturn(...) — ${describeStubbed()}.`,
      );
    }

    if (stub.constraint !== undefined && !matchesConstraint(body, stub.constraint)) {
      reject(
        `${method} was called with arguments the stub does not accept.\n` +
          `  expected to include: ${JSON.stringify(stub.constraint)}\n` +
          `  actual body:         ${JSON.stringify(body)}`,
      );
    }

    return stub;
  }

  function answer(
    stub: StubState,
    method: string,
    body: Record<string, unknown>,
  ): Record<string, unknown> {
    if (stub.httpFailure !== undefined) throw new HttpFailureSignal(stub.httpFailure);
    if (stub.failure !== undefined) return { ok: false, error: stub.failure };
    if (stub.respond !== undefined) return asRecord(stub.respond(body));

    if (stub.sequence) {
      const next = stub.responses.shift();
      if (next === undefined) {
        reject(`${method} was called more times than andReturnEach declared responses for.`);
      }
      return asRecord(next);
    }

    const only = stub.responses[0];
    if (only === undefined) {
      reject(`${method} is stubbed but no response was declared for it.`);
    }
    return asRecord(only);
  }

  const fetchImpl: typeof globalThis.fetch = async (target, init) => {
    const request = target instanceof Request ? target : undefined;
    const url = request?.url ?? String(target);
    const headers = new Headers(request?.headers ?? init?.headers ?? {});
    const contentType = headers.get("content-type");
    const httpMethod = (request?.method ?? init?.method ?? "GET").toUpperCase();
    const rawBody = request === undefined ? init?.body : await request.clone().text();

    const uploadTicket = matchPath(url, `${origin}/files/upload/`);
    if (uploadTicket !== undefined) {
      calls.push({ method: "files.upload", url, body: undefined, contentType });
      requireBearer("files.upload", headers);
      const failure = takeQueued(failNextHttpQueue, "files.upload");
      if (failure !== undefined) return httpFailureResponse(failure);
      uploads.push(await toBytes(request === undefined ? init?.body : request.clone().body));
      return new Response("OK", { status: 200 });
    }

    const downloadPath = matchPath(url, `${origin}/files/`);
    if (downloadPath !== undefined) {
      calls.push({ method: "files.download", url, body: undefined, contentType });
      requireBearer("files.download", headers);
      const failure = takeQueued(failNextHttpQueue, "files.download");
      if (failure !== undefined) return httpFailureResponse(failure);
      const bytes = downloads.shift();
      if (bytes === undefined) {
        reject(
          `a url_private download of ${url} was attempted but no bytes were declared. ` +
            `Declare them with slack.allowDownload(bytes).`,
        );
      }
      return new Response(bytes, { status: 200 });
    }

    if (!url.startsWith(base)) {
      reject(`request to ${url} does not target the configured base ${base}`);
    }
    const method = url.slice(base.length);
    const body = decodeSlackApiBody(rawBody, contentType);
    calls.push({ method, url, body, contentType });

    if (httpMethod !== "POST") reject(`${method} was sent as ${httpMethod}, Slack requires POST`);
    requireBearer(method, headers);
    requireEncoding(method, contentType);

    const stub = requireStub(method, asRecord(body));

    const queuedHttp = takeQueued(failNextHttpQueue, method);
    if (queuedHttp !== undefined) return httpFailureResponse(queuedHttp);
    const queuedFailure = takeQueued(failNextQueue, method);
    if (queuedFailure !== undefined) {
      return jsonResponse({ ok: false, error: queuedFailure });
    }

    try {
      return jsonResponse(answer(stub, method, asRecord(body)));
    } catch (error) {
      if (error instanceof HttpFailureSignal) return httpFailureResponse(error.failure);
      throw error;
    }
  };

  function requireBearer(method: string, headers: Headers): void {
    const authorization = headers.get("authorization") ?? "";
    if (!/^Bearer \S/.test(authorization)) {
      reject(`${method} carried no bearer token (authorization: ${JSON.stringify(authorization)})`);
    }
  }

  function requireEncoding(method: string, contentType: string | null): void {
    const expected = JSON_METHODS.has(method)
      ? ["application/x-www-form-urlencoded", "application/json"]
      : ["application/x-www-form-urlencoded"];
    if (expected.some((candidate) => contentType?.includes(candidate) === true)) return;
    reject(
      `${method} was sent as ${JSON.stringify(contentType)}; Slack's JSON support is partial, ` +
        `so eve form-encodes everything except ${[...JSON_METHODS].join(", ")}`,
    );
  }

  function stubFor(method: string): StubState {
    const existing = stubs.get(method);
    if (existing !== undefined) return existing;
    const created: StubState = { responses: [], sequence: false };
    stubs.set(method, created);
    return created;
  }

  return {
    fetch: fetchImpl,
    url: base,
    calls,
    violations,
    callsTo(method) {
      return calls.filter((call) => call.method === method);
    },
    bodyOf<M extends SlackApiMethod>(method: M, index = 0): SlackApiRequest<M> {
      const matching = calls.filter((call) => call.method === method);
      const call = matching[index];
      if (call === undefined) {
        throw new Error(
          `mockSlack: expected at least ${index + 1} call(s) to ${method}, saw ${matching.length}. ` +
            `Observed methods: ${[...new Set(calls.map((entry) => entry.method))].join(", ") || "none"}.`,
        );
      }
      // A recorded body is `unknown` until the method name says what
      // it is. Casting here is what lets assertion sites read a typed
      // field.
      return asRecord(call.body) as SlackApiRequest<M>;
    },
    observedMethods() {
      return [...new Set(calls.map((call) => call.method))];
    },
    allow(method) {
      const state = stubFor(method);
      const stub: MockSlackStub<typeof method> = {
        // The last answer declared for a method wins: each of these
        // clears the others, so re-stubbing after an andFail takes
        // effect. `with` is not an answer — it narrows whichever answer
        // is declared, so it survives a re-declaration.
        andReturn(response) {
          clearAnswer(state);
          state.responses = [response];
          return stub;
        },
        andReturnEach(responses) {
          clearAnswer(state);
          state.responses = [...responses];
          state.sequence = true;
          return stub;
        },
        andReturnRaw(response) {
          clearAnswer(state);
          state.responses = [response];
          return stub;
        },
        andRespond(respond) {
          clearAnswer(state);
          state.respond = respond as (body: Record<string, unknown>) => unknown;
          return stub;
        },
        with(expected) {
          state.constraint = expected as Record<string, unknown>;
          return stub;
        },
        andFail(error) {
          clearAnswer(state);
          state.failure = error;
          return stub;
        },
        andFailHttp(failure) {
          clearAnswer(state);
          state.httpFailure = failure;
          return stub;
        },
      };
      return stub;
    },
    allowUncheckedMethod(method, response) {
      const state = stubFor(method);
      clearAnswer(state);
      state.responses = [response];
    },
    reject,
    failNext(method, error) {
      failNextQueue.set(method, [...(failNextQueue.get(method) ?? []), error]);
    },
    failNextHttp(method, failure) {
      failNextHttpQueue.set(method, [...(failNextHttpQueue.get(method) ?? []), failure]);
    },
    uploadUrl(fileId) {
      return `${origin}/files/upload/${fileId}`;
    },
    downloadUrl(path) {
      return `${origin}/files/${path}`;
    },
    uploadedBytes() {
      return uploads;
    },
    allowDownload(bytes) {
      downloads.push(bytes);
    },
    assertNoViolations() {
      if (violations.length === 0) return;
      throw new Error(`mockSlack observed protocol violations:\n- ${violations.join("\n- ")}`);
    },
  };
}

/** Thrown inside `answer` so `.andFailHttp` reaches the transport layer. */
class HttpFailureSignal extends Error {
  readonly failure: MockSlackHttpFailure;

  constructor(failure: MockSlackHttpFailure) {
    super("mockSlack http failure");
    this.failure = failure;
  }
}

/**
 * Drops whatever answer a stub currently holds, so the next
 * declaration is the only one in play.
 */
function clearAnswer(state: StubState): void {
  state.responses = [];
  state.sequence = false;
  state.respond = undefined;
  state.failure = undefined;
  state.httpFailure = undefined;
}

function matchesConstraint(
  body: Record<string, unknown>,
  constraint: Record<string, unknown>,
): boolean {
  return Object.entries(constraint).every(
    ([key, value]) => JSON.stringify(body[key]) === JSON.stringify(value),
  );
}

function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  if (!parsed.pathname.endsWith("/")) parsed.pathname = `${parsed.pathname}/`;
  return parsed.toString();
}

function matchPath(url: string, prefix: string): string | undefined {
  return url.startsWith(prefix) ? url.slice(prefix.length) : undefined;
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function httpFailureResponse(failure: MockSlackHttpFailure): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (failure.retryAfter !== undefined) {
    headers.set("retry-after", String(failure.retryAfter));
  }
  return new Response(JSON.stringify(failure.body ?? { ok: false }), {
    status: failure.status,
    headers,
  });
}

async function toBytes(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof ReadableStream) {
    return new Uint8Array(await new Response(body).arrayBuffer());
  }
  if (typeof body === "string") return new TextEncoder().encode(body);
  return new Uint8Array();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
