import type { FilePart, UserContent } from "ai";
import { describe, expect, it, vi } from "vitest";

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapter } from "#channel/adapter.js";
import { isCompiledChannel } from "#channel/compiled-channel.js";
import { createJsonMessageRequest } from "#internal/testing/route-harness.js";
import { type AuthFn, none } from "#public/channels/auth.js";
import { eveChannel, defaultEveAuth, type EveChannelInput } from "#public/channels/eve.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { RouteHandlerArgs, SendFn, SendOptions, SendPayload } from "#channel/routes.js";
import type { Session as ChannelSession } from "#channel/session.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import type { ContextAccessor } from "#context/key.js";
import {
  ContinuationTokenKey,
  SessionIdKey,
  SessionKey,
  type Session as RuntimeSession,
} from "#context/keys.js";
import { createMessageCompletedEvent } from "#protocol/message.js";

/**
 * Unit coverage for the inbound HTTP route's message-body parser and
 * the upload-policy enforcement layer.
 *
 * The `send` function is mocked so the test stays pinned to the
 * request -> response contract. End-to-end flow through the harness
 * lives in the integration tier.
 */

const KILOBYTE = 1024;

const ACCEPTED_AUTH: SessionAuthContext = {
  attributes: { plan: "pro" },
  authenticator: "test-fixture",
  principalId: "user-1",
  principalType: "user",
};

const OVERRIDE_AUTH: SessionAuthContext = {
  attributes: { role: "admin" },
  authenticator: "eve-on-message",
  principalId: "user-2",
  principalType: "user",
};

/**
 * Creates a POST handler test harness for the create route (POST /eve/v1/session).
 * Returns a `fetch(req)` function and a `send` mock so tests can inspect
 * what the handler passed through.
 */
function createEveCreateHandler(input: EveChannelInput) {
  const channel = eveChannel(input);
  const createRoute = channel.routes.find(
    (r) => r.method === "POST" && r.path === "/eve/v1/session",
  );
  if (!createRoute) throw new Error("No create POST route found");

  const mockSend = vi.fn<SendFn>().mockResolvedValue({
    id: "test-session-id",
    continuationToken: "eve:test",
    async getEventStream() {
      return new ReadableStream();
    },
  } satisfies ChannelSession);

  return {
    send: mockSend,
    async fetch(req: Request) {
      const args: RouteHandlerArgs = {
        send: mockSend,
        getSession: vi.fn(),
        receive: vi.fn() as any,
        params: {},
        waitUntil: () => undefined,
        requestIp: "127.0.0.1",
      };
      return (createRoute as any).handler(req, args);
    },
  };
}

/**
 * Creates a POST handler test harness for the continue route
 * (POST /eve/v1/session/:sessionId).
 */
function createEveContinueHandler(input: EveChannelInput) {
  const channel = eveChannel(input);
  const continueRoute = channel.routes.find(
    (r) => r.method === "POST" && r.path === "/eve/v1/session/:sessionId",
  );
  if (!continueRoute) throw new Error("No continue POST route found");

  const mockSession: ChannelSession = {
    id: "test-session-id",
    continuationToken: "eve:test",
    async getEventStream() {
      return new ReadableStream();
    },
  };

  const mockSend = vi.fn<SendFn>().mockResolvedValue(mockSession);
  const mockGetSession = vi.fn().mockReturnValue(mockSession);

  return {
    send: mockSend,
    async fetch(req: Request) {
      const args: RouteHandlerArgs = {
        send: mockSend,
        getSession: mockGetSession,
        receive: vi.fn() as any,
        params: { sessionId: "test-session-id" },
        waitUntil: () => undefined,
        requestIp: "127.0.0.1",
      };
      return (continueRoute as any).handler(req, args);
    },
  };
}

/** Creates a GET handler test harness for the durable session stream route. */
function createEveStreamHandler(input: EveChannelInput) {
  const channel = eveChannel(input);
  const streamRoute = channel.routes.find(
    (route) => route.method === "GET" && route.path === "/eve/v1/session/:sessionId/stream",
  );
  if (!streamRoute) throw new Error("No session stream GET route found");

  const getEventStream = vi.fn().mockResolvedValue(new ReadableStream());
  const mockGetSession = vi.fn().mockReturnValue({
    continuationToken: "eve:test",
    getEventStream,
    id: "test-session-id",
  } satisfies ChannelSession);

  return {
    getEventStream,
    async fetch(url: string) {
      const args: RouteHandlerArgs = {
        send: vi.fn(),
        getSession: mockGetSession,
        receive: vi.fn() as any,
        params: { sessionId: "test-session-id" },
        waitUntil: () => undefined,
        requestIp: "127.0.0.1",
      };
      return (streamRoute as any).handler(new Request(url), args);
    },
  };
}

function filePartBody(
  overrides: Partial<FilePart> & { data: FilePart["data"] } & { mediaType: FilePart["mediaType"] },
): {
  readonly mediaType: string;
  readonly data: FilePart["data"];
  readonly filename?: string;
  readonly type: "file";
} {
  const body: {
    mediaType: string;
    data: FilePart["data"];
    filename?: string;
    type: "file";
  } = {
    data: overrides.data,
    mediaType: overrides.mediaType,
    type: "file",
  };
  if (overrides.filename !== undefined) {
    body.filename = overrides.filename;
  }
  return body;
}

function getEveAdapter(input: EveChannelInput): ChannelAdapter {
  const channel = eveChannel(input);
  if (!isCompiledChannel(channel)) {
    throw new Error("Expected eveChannel() to return a compiled channel.");
  }
  return channel.adapter;
}

function contextAccessorFor(ctx: ContextContainer): ContextAccessor {
  return {
    get: (key) => ctx.get(key as any),
    has: (key) => ctx.has(key as any),
    require: (key) => ctx.require(key as any),
    set: (key, value) => ctx.set(key as any, value),
    ensure: (key, create) => ctx.ensure(key as any, create),
  };
}

describe("eveChannel — events", () => {
  it("leaves CORS disabled by default", () => {
    const channel = eveChannel({ auth: none() });
    if (!isCompiledChannel(channel)) {
      throw new Error("Expected eveChannel() to return a compiled channel.");
    }

    expect(channel.cors).toBeUndefined();
  });

  it("accepts true for explicit permissive CORS", () => {
    const channel = eveChannel({ auth: none(), cors: true });
    if (!isCompiledChannel(channel)) {
      throw new Error("Expected eveChannel() to return a compiled channel.");
    }

    expect(channel.cors).toEqual({});
  });

  it("allows CORS to be disabled", () => {
    const channel = eveChannel({ auth: none(), cors: false });
    if (!isCompiledChannel(channel)) {
      throw new Error("Expected eveChannel() to return a compiled channel.");
    }

    expect(channel.cors).toBeUndefined();
  });

  it("normalizes higher-level CORS options", () => {
    const channel = eveChannel({
      auth: none(),
      cors: {
        allowedHeaders: ["authorization"],
        credentials: true,
        exposedHeaders: ["x-eve-session-id"],
        maxAge: 300,
        methods: ["POST", "GET"],
        origin: "https://app.example.com",
        preflightStatus: 200,
      },
    });
    if (!isCompiledChannel(channel)) {
      throw new Error("Expected eveChannel() to return a compiled channel.");
    }

    expect(channel.cors).toEqual({
      allowHeaders: ["authorization"],
      credentials: true,
      exposeHeaders: ["x-eve-session-id"],
      maxAge: "300",
      methods: ["POST", "GET"],
      origin: ["https://app.example.com"],
      preflight: { statusCode: 200 },
    });
  });

  it("passes wildcard values through inside CORS options", () => {
    const channel = eveChannel({
      auth: none(),
      cors: {
        allowedHeaders: "*",
        exposedHeaders: "*",
        methods: "*",
        origin: "*",
      },
    });
    if (!isCompiledChannel(channel)) {
      throw new Error("Expected eveChannel() to return a compiled channel.");
    }

    expect(channel.cors).toEqual({
      allowHeaders: "*",
      exposeHeaders: "*",
      methods: "*",
      origin: "*",
    });
  });

  it("passes configured event handlers through with session context", async () => {
    const observed: string[] = [];
    const adapter = getEveAdapter({
      auth: none(),
      events: {
        "message.completed"(data, channel, ctx) {
          observed.push(data.message ?? "");
          observed.push(channel.continuationToken);
          observed.push(ctx.session.id);
        },
      },
    });

    const session: RuntimeSession = {
      auth: { current: null, initiator: null },
      sessionId: "sess-eve-event",
      turn: { id: "turn-1", sequence: 1 },
    };
    const ctx = new ContextContainer();
    ctx.set(ContinuationTokenKey, "eve:continuation");
    ctx.set(SessionIdKey, "sess-eve-event");
    ctx.set(SessionKey, session);

    const adapterCtx = buildAdapterContext(adapter, contextAccessorFor(ctx));
    await contextStorage.run(ctx, async () => {
      await callAdapterEventHandler(
        adapter,
        createMessageCompletedEvent({
          message: "done",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn-1",
        }),
        adapterCtx,
      );
    });

    expect(observed).toEqual(["done", "eve:continuation", "sess-eve-event"]);
  });
});

describe("eveChannel — stream cursor", () => {
  it("forwards negative tail-relative start indices", async () => {
    const handler = createEveStreamHandler({ auth: none() });

    const response = await handler.fetch(
      "https://eve.test/eve/v1/session/test-session-id/stream?startIndex=-1",
    );

    expect(response.status).toBe(200);
    expect(handler.getEventStream).toHaveBeenCalledWith({ startIndex: -1 });
  });

  it.each(["1.5", "1junk", "0x10", "1e2", ""])(
    "rejects a non-decimal-integer start index %j",
    async (startIndex) => {
      const handler = createEveStreamHandler({ auth: none() });
      const response = await handler.fetch(
        `https://eve.test/eve/v1/session/test-session-id/stream?startIndex=${encodeURIComponent(startIndex)}`,
      );

      expect(response.status).toBe(400);
      expect(handler.getEventStream).not.toHaveBeenCalled();
    },
  );
});

describe("eveChannel — onMessage", () => {
  it("runs after auth on create requests and appends returned context", async () => {
    const onMessage = vi.fn((ctx, message) => {
      expect(ctx.eve.caller).toEqual(ACCEPTED_AUTH);
      expect(defaultEveAuth(ctx)).toEqual(ACCEPTED_AUTH);
      expect(ctx.eve.sessionId).toBeUndefined();
      expect(ctx.eve.request.url).toBe("https://example.com/eve/v1/session");
      expect(message).toBe("What word is selected?");
      return { auth: defaultEveAuth(ctx), context: ["Authenticated caller profile: enterprise"] };
    });
    const handler = createEveCreateHandler({
      auth: () => ACCEPTED_AUTH,
      onMessage,
    });

    const response = await handler.fetch(
      createJsonMessageRequest({
        clientContext: "selection: jazz",
        message: "What word is selected?",
      }),
    );

    expect(response.status).toBe(202);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(handler.send).toHaveBeenCalledTimes(1);
    const payload = handler.send.mock.calls[0]?.[0] as SendPayload;
    expect(payload).toEqual({
      message: "What word is selected?",
      context: ["Client context:\nselection: jazz", "Authenticated caller profile: enterprise"],
    });
    const options = handler.send.mock.calls[0]?.[1] as SendOptions;
    expect(options.auth).toEqual(ACCEPTED_AUTH);
  });

  it("uses auth returned from onMessage for create requests", async () => {
    const handler = createEveCreateHandler({
      auth: () => ACCEPTED_AUTH,
      onMessage: () => ({ auth: OVERRIDE_AUTH, context: ["override context"] }),
    });

    const response = await handler.fetch(createJsonMessageRequest({ message: "hi" }));

    expect(response.status).toBe(202);
    expect(handler.send).toHaveBeenCalledTimes(1);
    const payload = handler.send.mock.calls[0]?.[0] as SendPayload;
    expect(payload).toEqual({ message: "hi", context: ["override context"] });
    const options = handler.send.mock.calls[0]?.[1] as SendOptions;
    expect(options.auth).toEqual(OVERRIDE_AUTH);
  });

  it("does not run onMessage when auth rejects", async () => {
    const onMessage = vi.fn(() => ({ auth: null, context: ["never"] }));
    const handler = createEveCreateHandler({
      auth: [],
      onMessage,
    });

    const response = await handler.fetch(createJsonMessageRequest({ message: "hi" }));

    expect(response.status).toBe(401);
    expect(onMessage).not.toHaveBeenCalled();
    expect(handler.send).not.toHaveBeenCalled();
  });

  it("accepts a create request without dispatching when onMessage returns null", async () => {
    const handler = createEveCreateHandler({
      auth: none(),
      onMessage: () => null,
    });

    const response = await handler.fetch(createJsonMessageRequest({ message: "hi" }));

    expect(response.status).toBe(204);
    expect(handler.send).not.toHaveBeenCalled();
  });

  it("allows onMessage to dispatch with an empty context array", async () => {
    const handler = createEveCreateHandler({
      auth: none(),
      onMessage: () => ({ auth: null, context: [] }),
    });

    const response = await handler.fetch(createJsonMessageRequest({ message: "hi" }));

    expect(response.status).toBe(202);
    expect(handler.send).toHaveBeenCalledTimes(1);
    expect(handler.send.mock.calls[0]?.[0]).toEqual({ message: "hi", context: [] });
    const options = handler.send.mock.calls[0]?.[1] as SendOptions;
    expect(options.auth).toBeNull();
  });

  it("returns 500 without dispatching when onMessage throws", async () => {
    const handler = createEveCreateHandler({
      auth: none(),
      onMessage: () => {
        throw new Error("lookup failed");
      },
    });

    const response = await handler.fetch(createJsonMessageRequest({ message: "hi" }));

    expect(response.status).toBe(500);
    expect(handler.send).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: "onMessage handler failed.",
      ok: false,
    });
  });

  it("passes session context to onMessage on continue requests", async () => {
    const onMessage = vi.fn((ctx, message) => {
      expect(ctx.eve.caller).toEqual(ACCEPTED_AUTH);
      expect(defaultEveAuth(ctx)).toEqual(ACCEPTED_AUTH);
      expect(ctx.eve.sessionId).toBe("test-session-id");
      expect(message).toBe("yes please");
      return { auth: defaultEveAuth(ctx), context: ["Authenticated continuation context"] };
    });
    const handler = createEveContinueHandler({
      auth: () => ACCEPTED_AUTH,
      onMessage,
    });

    const response = await handler.fetch(
      createJsonMessageRequest({
        clientContext: "approval modal open",
        continuationToken: "http:existing",
        inputResponses: [{ requestId: "req-1", optionId: "approve" }],
        message: "yes please",
      }),
    );

    expect(response.status).toBe(200);
    expect(onMessage).toHaveBeenCalledTimes(1);
    const payload = handler.send.mock.calls[0]?.[0] as SendPayload;
    expect(payload.context).toEqual([
      "Client context:\napproval modal open",
      "Authenticated continuation context",
    ]);
    expect(payload.inputResponses).toEqual([{ requestId: "req-1", optionId: "approve" }]);
    const options = handler.send.mock.calls[0]?.[1] as SendOptions;
    expect(options.auth).toEqual(ACCEPTED_AUTH);
  });

  it("does not run onMessage for inputResponses-only continue requests", async () => {
    const onMessage = vi.fn(() => ({ auth: OVERRIDE_AUTH, context: ["never"] }));
    const handler = createEveContinueHandler({
      auth: () => ACCEPTED_AUTH,
      onMessage,
    });

    const response = await handler.fetch(
      createJsonMessageRequest({
        continuationToken: "http:existing",
        inputResponses: [{ requestId: "req-1", optionId: "deny" }],
      }),
    );

    expect(response.status).toBe(200);
    expect(onMessage).not.toHaveBeenCalled();
    expect(handler.send).toHaveBeenCalledTimes(1);
    const payload = handler.send.mock.calls[0]?.[0] as SendPayload;
    expect(payload.context).toBeUndefined();
    const options = handler.send.mock.calls[0]?.[1] as SendOptions;
    expect(options.auth).toEqual(ACCEPTED_AUTH);
  });
});

describe("eveChannel — create session (text)", () => {
  it("accepts a plain-string message and opens a new session", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const response = await handler.fetch(createJsonMessageRequest({ message: "hi" }));

    expect(response.status).toBe(202);
    expect(handler.send).toHaveBeenCalledTimes(1);
    expect(handler.send.mock.calls[0]?.[0]).toBe("hi");
  });

  it("accepts task mode for callback-driven session creation", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const response = await handler.fetch(createJsonMessageRequest({ message: "hi", mode: "task" }));

    expect(response.status).toBe(202);
    expect(handler.send).toHaveBeenCalledTimes(1);
    expect(handler.send.mock.calls[0]?.[1]).toMatchObject({ mode: "task" });
  });

  it("accepts remote-agent callback metadata for task sessions", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const response = await handler.fetch(
      createJsonMessageRequest({
        callback: {
          callId: "call-1",
          subagentName: "research",
          token: "tok123",
          url: "https://caller.example.com/eve/v1/callback/tok123",
        },
        message: "hi",
        mode: "task",
      }),
    );

    expect(response.status).toBe(202);
    expect(handler.send).toHaveBeenCalledTimes(1);
    expect(handler.send.mock.calls[0]?.[1]).toMatchObject({
      callback: {
        callId: "call-1",
        subagentName: "research",
        token: "tok123",
        url: "https://caller.example.com/eve/v1/callback/tok123",
      },
      mode: "task",
    });
  });

  it("rejects callback metadata without a call id", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const response = await handler.fetch(
      createJsonMessageRequest({
        callback: {
          subagentName: "research",
          token: "tok123",
          url: "https://caller.example.com/eve/v1/callback/tok123",
        },
        message: "hi",
        mode: "task",
      }),
    );

    expect(response.status).toBe(400);
    expect(handler.send).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("callId"),
    });
  });

  it("rejects callback metadata whose URL token does not match the token field", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const response = await handler.fetch(
      createJsonMessageRequest({
        callback: {
          callId: "call-1",
          subagentName: "research",
          token: "tok123",
          url: "https://caller.example.com/eve/v1/callback/other-token",
        },
        message: "hi",
        mode: "task",
      }),
    );

    expect(response.status).toBe(400);
    expect(handler.send).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Callback url token must match callback token"),
    });
  });

  it("rejects callback metadata with extra fields", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const response = await handler.fetch(
      createJsonMessageRequest({
        callback: {
          callId: "call-1",
          extra: true,
          subagentName: "research",
          token: "tok123",
          url: "https://caller.example.com/eve/v1/callback/tok123",
        },
        message: "hi",
        mode: "task",
      }),
    );

    expect(response.status).toBe(400);
    expect(handler.send).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Unrecognized key"),
    });
  });

  it("rejects invalid create-session modes", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const response = await handler.fetch(
      createJsonMessageRequest({ message: "hi", mode: "background" }),
    );

    expect(response.status).toBe(400);
    expect(handler.send).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("mode"),
    });
  });

  it("converts clientContext with a create-session message", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const response = await handler.fetch(
      createJsonMessageRequest({
        clientContext: { selectedWord: "jazz" },
        message: "What word is selected?",
      }),
    );

    expect(response.status).toBe(202);
    expect(handler.send).toHaveBeenCalledTimes(1);
    const payload = handler.send.mock.calls[0]?.[0] as SendPayload;
    expect(payload).toEqual({
      message: "What word is selected?",
      context: ['Client context:\n{"selectedWord":"jazz"}'],
    });
  });

  it("forwards outputSchema with a create-session message", async () => {
    const handler = createEveCreateHandler({ auth: none() });
    const outputSchema = {
      properties: { title: { type: "string" } },
      required: ["title"],
      type: "object",
    } as const;

    const response = await handler.fetch(
      createJsonMessageRequest({
        message: "Summarize",
        outputSchema,
      }),
    );

    expect(response.status).toBe(202);
    expect(handler.send).toHaveBeenCalledTimes(1);
    const payload = handler.send.mock.calls[0]?.[0] as SendPayload;
    expect(payload).toEqual({ message: "Summarize", outputSchema });
  });

  it("rejects invalid create-session outputSchema values", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const response = await handler.fetch(
      createJsonMessageRequest({
        message: "Summarize",
        outputSchema: [],
      }),
    );

    expect(response.status).toBe(400);
    expect(handler.send).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("outputSchema"),
    });
  });

  it("converts string-array clientContext into ordered context strings", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const response = await handler.fetch(
      createJsonMessageRequest({
        clientContext: ["route: /editor", "selection: jazz"],
        message: "What word is selected?",
      }),
    );

    expect(response.status).toBe(202);
    expect(handler.send).toHaveBeenCalledTimes(1);
    const payload = handler.send.mock.calls[0]?.[0] as SendPayload;
    expect(payload.context).toEqual([
      "Client context:\nroute: /editor",
      "Client context:\nselection: jazz",
    ]);
  });

  it("rejects invalid create-session clientContext", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const response = await handler.fetch(
      createJsonMessageRequest({
        clientContext: [42],
        message: "hi",
      }),
    );

    expect(response.status).toBe(400);
    expect(handler.send).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("clientContext"),
    });
  });

  it("treats an empty string as a missing message", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const response = await handler.fetch(createJsonMessageRequest({ message: "" }));

    expect(response.status).toBe(400);
    expect(handler.send).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON bodies with 400", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const response = await handler.fetch(
      new Request("https://example.com/eve/v1/session", {
        body: "not-json",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
    expect(handler.send).not.toHaveBeenCalled();
  });

  it("rejects non-object payloads with 400", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const response = await handler.fetch(createJsonMessageRequest(42));

    expect(response.status).toBe(400);
  });
});

describe("eveChannel — create session (UserContent array)", () => {
  it("accepts a text+file UserContent array and forwards it to send", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const base64 = Buffer.from("id,name\n1,alpha\n", "utf8").toString("base64");
    const response = await handler.fetch(
      createJsonMessageRequest({
        message: [
          { type: "text", text: "summarize this csv" },
          filePartBody({ data: base64, filename: "report.csv", mediaType: "text/csv" }),
        ],
      }),
    );

    expect(response.status).toBe(202);
    expect(handler.send).toHaveBeenCalledTimes(1);
    const message = handler.send.mock.calls[0]?.[0] as UserContent;
    expect(Array.isArray(message)).toBe(true);
    expect(message).toHaveLength(2);
    expect(message[0]).toEqual({ type: "text", text: "summarize this csv" });
    const filePart = message[1] as FilePart;
    expect(filePart.type).toBe("file");
    expect(filePart.mediaType).toBe("text/csv");
    expect(filePart.filename).toBe("report.csv");
    expect(filePart.data).toBe(base64);
  });

  it("accepts a data-URL payload and preserves it verbatim for the harness", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const dataUrl = "data:text/plain;base64,SGVsbG8=";
    const response = await handler.fetch(
      createJsonMessageRequest({
        message: [filePartBody({ data: dataUrl, mediaType: "text/plain" })],
      }),
    );

    expect(response.status).toBe(202);
    const message = handler.send.mock.calls[0]?.[0] as UserContent;
    expect((message[0] as FilePart)?.data).toBe(dataUrl);
  });

  it("treats an empty UserContent array as missing", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const response = await handler.fetch(createJsonMessageRequest({ message: [] }));

    expect(response.status).toBe(400);
    expect(handler.send).not.toHaveBeenCalled();
  });

  it("rejects a text part with an empty string", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const response = await handler.fetch(
      createJsonMessageRequest({ message: [{ type: "text", text: "" }] }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("text"),
    });
  });

  it("rejects a file part missing mediaType", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const response = await handler.fetch(
      createJsonMessageRequest({ message: [{ type: "file", data: "aGk=" }] }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("mediaType"),
    });
  });

  it("rejects a file part whose data is not a string", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const response = await handler.fetch(
      createJsonMessageRequest({
        message: [{ type: "file", mediaType: "text/csv", data: { oops: true } }],
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("data"),
    });
  });

  it("rejects a file part whose data carries a framework-internal ref scheme", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    // The `eve-url:eve-sandbox:` gadget would otherwise be reconstituted by the
    // staging pipeline into an arbitrary sandbox file read before the model call.
    const response = await handler.fetch(
      createJsonMessageRequest({
        message: [
          filePartBody({
            data: "eve-url:eve-sandbox:?path=/etc/passwd&size=1&type=image/png",
            mediaType: "image/png",
          }),
        ],
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("internal ref scheme"),
    });
  });

  it("rejects a file part whose data is a bare internal sandbox ref", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const response = await handler.fetch(
      createJsonMessageRequest({
        message: [filePartBody({ data: "eve-sandbox:?path=/etc/passwd", mediaType: "image/png" })],
      }),
    );

    expect(response.status).toBe(400);
  });

  it("rejects unknown part types with a helpful error", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const response = await handler.fetch(
      createJsonMessageRequest({ message: [{ type: "bogus" }] }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("bogus"),
    });
  });

  it("rejects non-object message parts", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const response = await handler.fetch(createJsonMessageRequest({ message: ["not-an-object"] }));

    expect(response.status).toBe(400);
  });

  it("rejects a message field that is neither string nor array", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const response = await handler.fetch(createJsonMessageRequest({ message: 42 }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("string or an array"),
    });
  });
});

describe("eveChannel — uploadPolicy enforcement", () => {
  it("rejects oversized attachments with 413 and a structured body", async () => {
    const handler = createEveCreateHandler({
      auth: none(),
      uploadPolicy: { maxBytes: 4 },
    });

    const base64 = Buffer.from("hello world", "utf8").toString("base64");
    const response = await handler.fetch(
      createJsonMessageRequest({
        message: [
          { type: "text", text: "summarize" },
          filePartBody({ data: base64, filename: "big.txt", mediaType: "text/plain" }),
        ],
      }),
    );

    expect(response.status).toBe(413);
    expect(handler.send).not.toHaveBeenCalled();
    const body = (await response.json()) as {
      violations: Array<{ kind: string; limit: number; byteLength: number; filename: string }>;
    };
    expect(body.violations).toHaveLength(1);
    expect(body.violations[0]).toMatchObject({
      byteLength: 11,
      filename: "big.txt",
      kind: "too-large",
      limit: 4,
    });
  });

  it("rejects disallowed media types with 415 and the allowed list", async () => {
    const handler = createEveCreateHandler({
      auth: none(),
      uploadPolicy: { allowedMediaTypes: ["text/csv"] },
    });

    const response = await handler.fetch(
      createJsonMessageRequest({
        message: [filePartBody({ data: "aGk=", filename: "photo.png", mediaType: "image/png" })],
      }),
    );

    expect(response.status).toBe(415);
    const body = (await response.json()) as {
      violations: Array<{ kind: string; allowedMediaTypes: string[]; mediaType: string }>;
    };
    expect(body.violations[0]).toMatchObject({
      allowedMediaTypes: ["text/csv"],
      kind: "disallowed-media-type",
      mediaType: "image/png",
    });
  });

  it("accepts uploads that fit within the framework default (25 MB)", async () => {
    const handler = createEveCreateHandler({ auth: none() });

    const base64 = Buffer.from(new Uint8Array(16 * KILOBYTE)).toString("base64");
    const response = await handler.fetch(
      createJsonMessageRequest({
        message: [
          filePartBody({ data: base64, filename: "ok.bin", mediaType: "application/octet-stream" }),
        ],
      }),
    );

    expect(response.status).toBe(202);
    expect(handler.send).toHaveBeenCalledTimes(1);
  });

  it("enforces upload policy on continue (continuationToken) requests as well", async () => {
    const handler = createEveContinueHandler({
      auth: none(),
      uploadPolicy: { maxBytes: 4 },
    });

    const base64 = Buffer.from("too-big-for-policy", "utf8").toString("base64");
    const response = await handler.fetch(
      createJsonMessageRequest({
        continuationToken: "http:existing",
        message: [filePartBody({ data: base64, filename: "big.txt", mediaType: "text/plain" })],
      }),
    );

    expect(response.status).toBe(413);
    expect(handler.send).not.toHaveBeenCalled();
  });

  it("checks media type before size when both fail", async () => {
    const handler = createEveCreateHandler({
      auth: none(),
      uploadPolicy: { allowedMediaTypes: ["text/csv"], maxBytes: 1 },
    });

    const base64 = Buffer.from("hello world", "utf8").toString("base64");
    const response = await handler.fetch(
      createJsonMessageRequest({
        message: [filePartBody({ data: base64, filename: "photo.png", mediaType: "image/png" })],
      }),
    );

    expect(response.status).toBe(415);
    const body = (await response.json()) as { violations: Array<{ kind: string }> };
    expect(body.violations[0]?.kind).toBe("disallowed-media-type");
  });
});

describe("eveChannel — continue session HITL (inputResponses)", () => {
  it("forwards inputResponses alongside a message", async () => {
    const handler = createEveContinueHandler({ auth: none() });

    const response = await handler.fetch(
      createJsonMessageRequest({
        continuationToken: "http:existing",
        inputResponses: [{ requestId: "req-1", optionId: "approve" }],
        message: "yes please",
      }),
    );

    expect(response.status).toBe(200);
    expect(handler.send).toHaveBeenCalledTimes(1);
    const payload = handler.send.mock.calls[0]?.[0] as SendPayload;
    expect(payload.message).toBe("yes please");
    expect(payload.inputResponses).toEqual([{ requestId: "req-1", optionId: "approve" }]);
  });

  it("converts clientContext on continue-session requests", async () => {
    const handler = createEveContinueHandler({ auth: none() });

    const response = await handler.fetch(
      createJsonMessageRequest({
        clientContext: "approval modal open",
        continuationToken: "http:existing",
        message: "yes please",
      }),
    );

    expect(response.status).toBe(200);
    expect(handler.send).toHaveBeenCalledTimes(1);
    const payload = handler.send.mock.calls[0]?.[0] as SendPayload;
    expect(payload.message).toBe("yes please");
    expect(payload.context).toEqual(["Client context:\napproval modal open"]);
  });

  it("forwards outputSchema with a continue-session message", async () => {
    const handler = createEveContinueHandler({ auth: none() });
    const outputSchema = {
      properties: { title: { type: "string" } },
      required: ["title"],
      type: "object",
    } as const;

    const response = await handler.fetch(
      createJsonMessageRequest({
        continuationToken: "http:existing",
        message: "Summarize",
        outputSchema,
      }),
    );

    expect(response.status).toBe(200);
    expect(handler.send).toHaveBeenCalledTimes(1);
    const payload = handler.send.mock.calls[0]?.[0] as SendPayload;
    expect(payload).toEqual({ message: "Summarize", outputSchema });
  });

  it("rejects invalid continue-session clientContext", async () => {
    const handler = createEveContinueHandler({ auth: none() });

    const response = await handler.fetch(
      createJsonMessageRequest({
        clientContext: 123,
        continuationToken: "http:existing",
        message: "hi",
      }),
    );

    expect(response.status).toBe(400);
    expect(handler.send).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("clientContext"),
    });
  });

  it("forwards inputResponses without a message", async () => {
    const handler = createEveContinueHandler({ auth: none() });

    const response = await handler.fetch(
      createJsonMessageRequest({
        continuationToken: "http:existing",
        inputResponses: [{ requestId: "req-1", optionId: "deny" }],
      }),
    );

    expect(response.status).toBe(200);
    expect(handler.send).toHaveBeenCalledTimes(1);
    const payload = handler.send.mock.calls[0]?.[0] as SendPayload;
    expect(payload.message).toBeUndefined();
    expect(payload.inputResponses).toEqual([{ requestId: "req-1", optionId: "deny" }]);
  });
});

describe("eveChannel — auth array shape", () => {
  const ACCEPTED: SessionAuthContext = {
    attributes: {},
    authenticator: "test-fixture",
    principalId: "user-1",
    principalType: "user",
  };

  it("walks the array in order, halting on the first SessionAuthContext", async () => {
    const order: string[] = [];
    const skipNull: AuthFn<Request> = () => {
      order.push("skip-null");
      return null;
    };
    const skipUndefined: AuthFn<Request> = () => {
      order.push("skip-undefined");
      return undefined;
    };
    const accept: AuthFn<Request> = () => {
      order.push("accept");
      return ACCEPTED;
    };

    const handler = createEveCreateHandler({ auth: [skipNull, skipUndefined, accept] });

    const response = await handler.fetch(createJsonMessageRequest({ message: "hi" }));

    expect(response.status).toBe(202);
    expect(order).toEqual(["skip-null", "skip-undefined", "accept"]);
    const options = handler.send.mock.calls[0]?.[1] as SendOptions;
    expect(options.auth).toEqual(ACCEPTED);
  });

  it("rejects with 401 when an empty array is supplied", async () => {
    const handler = createEveCreateHandler({ auth: [] });

    const response = await handler.fetch(createJsonMessageRequest({ message: "hi" }));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(handler.send).not.toHaveBeenCalled();
  });

  it("rejects with 401 when every entry skips", async () => {
    const handler = createEveCreateHandler({
      auth: [() => null, () => undefined, () => null],
    });

    const response = await handler.fetch(createJsonMessageRequest({ message: "hi" }));

    expect(response.status).toBe(401);
    expect(handler.send).not.toHaveBeenCalled();
  });

  it("still accepts a single AuthFn (not in an array)", async () => {
    const handler = createEveCreateHandler({ auth: () => ACCEPTED });

    const response = await handler.fetch(createJsonMessageRequest({ message: "hi" }));

    expect(response.status).toBe(202);
    const options = handler.send.mock.calls[0]?.[1] as SendOptions;
    expect(options.auth).toEqual(ACCEPTED);
  });

  it("propagates the resolved auth context onto send() for the continue route", async () => {
    const handler = createEveContinueHandler({
      auth: [() => null, () => ACCEPTED],
    });

    const response = await handler.fetch(
      createJsonMessageRequest({
        continuationToken: "http:existing",
        message: "follow-up",
      }),
    );

    expect(response.status).toBe(200);
    const options = handler.send.mock.calls[0]?.[1] as SendOptions;
    expect(options.auth).toEqual(ACCEPTED);
  });
});
