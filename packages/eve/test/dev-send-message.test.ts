import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EVE_SESSION_ID_HEADER,
  createActionResultEvent,
  createActionsRequestedEvent,
  createMessageCompletedEvent,
  createMessageReceivedEvent,
  createSessionWaitingEvent,
  createTurnCompletedEvent,
  createTurnStartedEvent,
} from "../src/protocol/message.js";
import { createEveMessageStreamRoutePath } from "../src/protocol/routes.js";
import {
  VERCEL_PROTECTION_BYPASS_HEADER,
  VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER,
} from "../src/services/dev-client/request-headers.js";
import { sendDevelopmentMessage } from "./dev-client-harness/send-message.js";
import { createDevelopmentSessionState } from "./dev-client-harness/session.js";

vi.mock("#compiled/@vercel/oidc/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("#compiled/@vercel/oidc/index.js")>();

  return {
    ...original,
    getVercelOidcToken: vi.fn(),
  };
});

function createControlledStreamResponse(): {
  close(): void;
  error(error: Error): void;
  pushEvent(event: unknown): void;
  response: Response;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  return {
    close() {
      controller?.close();
    },
    error(error) {
      controller?.error(error);
    },
    pushEvent(event) {
      controller?.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    },
    response: new Response(
      new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController;
        },
      }),
    ),
  };
}

function createStartedMessageResponse(
  sessionId: string,
  continuationToken: string,
  location: string,
): Response {
  return new Response(JSON.stringify({ continuationToken, ok: true, sessionId }), {
    headers: {
      "content-type": "application/json",
      location,
      [EVE_SESSION_ID_HEADER]: sessionId,
    },
    status: 202,
  });
}

function createResumedMessageResponse(continuationToken: string): Response {
  return new Response(JSON.stringify({ continuationToken, ok: true }), {
    headers: {
      "content-type": "application/json",
    },
    status: 200,
  });
}

function createOpenStreamResponse(events: readonly unknown[]): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
      },
    }),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(getVercelOidcToken).mockReset();
  vi.restoreAllMocks();
});

describe("sendDevelopmentMessage", () => {
  it("opens a fresh run stream from the stored cursor for each follow-up message", async () => {
    const firstStream = createControlledStreamResponse();
    const secondStream = createControlledStreamResponse();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        createStartedMessageResponse(
          "session_001",
          "http:session_001",
          createEveMessageStreamRoutePath("session_001"),
        ),
      )
      .mockResolvedValueOnce(firstStream.response)
      .mockResolvedValueOnce(createResumedMessageResponse("http:session_001"))
      .mockResolvedValueOnce(secondStream.response);

    const firstPromise = sendDevelopmentMessage({
      message: "Brooklyn",
      serverUrl: "http://localhost:3000",
      session: createDevelopmentSessionState(),
    });

    setTimeout(() => {
      firstStream.pushEvent(
        createTurnStartedEvent({
          sequence: 1,
          turnId: "turn_001",
        }),
      );
      firstStream.pushEvent(
        createMessageReceivedEvent({
          message: "Brooklyn",
          sequence: 1,
          turnId: "turn_001",
        }),
      );
      firstStream.pushEvent(
        createMessageCompletedEvent({
          message: "Bootstrap reply: Brooklyn",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_001",
        }),
      );
      firstStream.pushEvent(createTurnCompletedEvent({ sequence: 1, turnId: "turn_001" }));
      firstStream.pushEvent(createSessionWaitingEvent());
    }, 0);

    const first = await firstPromise;
    const secondPromise = sendDevelopmentMessage({
      message: "Thanks",
      serverUrl: "http://localhost:3000",
      session: first.session,
    });

    setTimeout(() => {
      secondStream.pushEvent(
        createTurnStartedEvent({
          sequence: 2,
          turnId: "turn_002",
        }),
      );
      secondStream.pushEvent(
        createMessageReceivedEvent({
          message: "Thanks",
          sequence: 2,
          turnId: "turn_002",
        }),
      );
      secondStream.pushEvent(
        createMessageCompletedEvent({
          message: "Bootstrap reply: Thanks",
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_002",
        }),
      );
      secondStream.pushEvent(createTurnCompletedEvent({ sequence: 2, turnId: "turn_002" }));
      secondStream.pushEvent(createSessionWaitingEvent());
    }, 0);

    const second = await secondPromise;

    expect(first.sessionId).toBe("session_001");
    expect(first.session).toEqual({
      boundaryCount: 1,
      continuationToken: "http:session_001",
      sessionId: "session_001",
      streamIndex: 5,
    });
    expect(second.sessionId).toBe("session_001");
    expect(second.session).toEqual({
      boundaryCount: 2,
      continuationToken: "http:session_001",
      sessionId: "session_001",
      streamIndex: 10,
    });
    expect(second.events).toEqual([
      {
        data: {
          sequence: 2,
          turnId: "turn_002",
        },
        type: "turn.started",
      },
      {
        data: {
          message: "Thanks",
          sequence: 2,
          turnId: "turn_002",
        },
        type: "message.received",
      },
      {
        data: {
          finishReason: "stop",
          message: "Bootstrap reply: Thanks",
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_002",
        },
        type: "message.completed",
      },
      {
        data: {
          sequence: 2,
          turnId: "turn_002",
        },
        type: "turn.completed",
      },
      {
        data: {
          wait: "next-user-message",
        },
        type: "session.waiting",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      createEveMessageStreamRoutePath("session_001"),
    );
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe("POST");
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain(
      `${createEveMessageStreamRoutePath("session_001")}?startIndex=5`,
    );
  });

  it("reconnects from the current cursor when a run stream terminates mid-turn", async () => {
    const firstStream = createControlledStreamResponse();
    const secondStream = createControlledStreamResponse();
    const resumedStream = createOpenStreamResponse([
      createMessageReceivedEvent({
        message: "What's the weather?",
        sequence: 2,
        turnId: "turn_002",
      }),
      createActionsRequestedEvent({
        actions: [
          {
            callId: "call_001",
            input: {
              location: "Brooklyn",
            },
            kind: "tool-call",
            toolName: "get_weather",
          },
        ],
        sequence: 2,
        stepIndex: 0,
        turnId: "turn_002",
      }),
      createActionResultEvent({
        result: {
          callId: "call_001",
          kind: "tool-result",
          output: {
            location: "Brooklyn",
            temperatureF: 72,
          },
          toolName: "get_weather",
        },
        sequence: 2,
        stepIndex: 0,
        turnId: "turn_002",
      }),
      createMessageCompletedEvent({
        message: "Bootstrap reply: Sunny in Brooklyn.",
        sequence: 2,
        stepIndex: 0,
        turnId: "turn_002",
      }),
      createTurnCompletedEvent({ sequence: 2, turnId: "turn_002" }),
      createSessionWaitingEvent(),
    ]);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        createStartedMessageResponse(
          "session_001",
          "http:session_001",
          createEveMessageStreamRoutePath("session_001"),
        ),
      )
      .mockResolvedValueOnce(firstStream.response)
      .mockResolvedValueOnce(createResumedMessageResponse("http:session_001"))
      .mockResolvedValueOnce(secondStream.response)
      .mockResolvedValueOnce(resumedStream);

    const firstPromise = sendDevelopmentMessage({
      message: "Brooklyn",
      serverUrl: "http://localhost:3000",
      session: createDevelopmentSessionState(),
    });

    setTimeout(() => {
      firstStream.pushEvent(
        createTurnStartedEvent({
          sequence: 1,
          turnId: "turn_001",
        }),
      );
      firstStream.pushEvent(
        createMessageReceivedEvent({
          message: "Brooklyn",
          sequence: 1,
          turnId: "turn_001",
        }),
      );
      firstStream.pushEvent(
        createMessageCompletedEvent({
          message: "Bootstrap reply: Brooklyn",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_001",
        }),
      );
      firstStream.pushEvent(createTurnCompletedEvent({ sequence: 1, turnId: "turn_001" }));
      firstStream.pushEvent(createSessionWaitingEvent());
    }, 0);

    const first = await firstPromise;

    const secondPromise = sendDevelopmentMessage({
      message: "What's the weather?",
      serverUrl: "http://localhost:3000",
      session: first.session,
    });

    setTimeout(() => {
      secondStream.pushEvent(
        createTurnStartedEvent({
          sequence: 2,
          turnId: "turn_002",
        }),
      );
      secondStream.error(new TypeError("terminated"));
    }, 0);

    const second = await secondPromise;

    expect(second.events).toEqual([
      {
        data: {
          sequence: 2,
          turnId: "turn_002",
        },
        type: "turn.started",
      },
      {
        data: {
          message: "What's the weather?",
          sequence: 2,
          turnId: "turn_002",
        },
        type: "message.received",
      },
      {
        data: {
          actions: [
            {
              callId: "call_001",
              input: {
                location: "Brooklyn",
              },
              kind: "tool-call",
              toolName: "get_weather",
            },
          ],
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_002",
        },
        type: "actions.requested",
      },
      {
        data: {
          result: {
            callId: "call_001",
            kind: "tool-result",
            output: {
              location: "Brooklyn",
              temperatureF: 72,
            },
            toolName: "get_weather",
          },
          sequence: 2,
          status: "completed",
          stepIndex: 0,
          turnId: "turn_002",
        },
        type: "action.result",
      },
      {
        data: {
          finishReason: "stop",
          message: "Bootstrap reply: Sunny in Brooklyn.",
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_002",
        },
        type: "message.completed",
      },
      {
        data: {
          sequence: 2,
          turnId: "turn_002",
        },
        type: "turn.completed",
      },
      {
        data: {
          wait: "next-user-message",
        },
        type: "session.waiting",
      },
    ]);
    expect(second.session).toEqual({
      boundaryCount: 2,
      continuationToken: "http:session_001",
      sessionId: "session_001",
      streamIndex: 12,
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(String(fetchMock.mock.calls[4]?.[0])).toContain(
      `${createEveMessageStreamRoutePath("session_001")}?startIndex=6`,
    );
  });

  it("forwards the Vercel protection bypass secret to message and stream requests", async () => {
    const stream = createControlledStreamResponse();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        createStartedMessageResponse(
          "session_001",
          "http:session_001",
          createEveMessageStreamRoutePath("session_001"),
        ),
      )
      .mockResolvedValueOnce(stream.response);

    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "secret_123");

    const messagePromise = sendDevelopmentMessage({
      headers: {
        authorization: "Basic dGVzdDpzZWNyZXQ=",
      },
      message: "Brooklyn",
      serverUrl: "https://example.com/preview",
      session: createDevelopmentSessionState(),
    });

    setTimeout(() => {
      stream.pushEvent(
        createTurnStartedEvent({
          sequence: 1,
          turnId: "turn_001",
        }),
      );
      stream.pushEvent(
        createMessageReceivedEvent({
          message: "Brooklyn",
          sequence: 1,
          turnId: "turn_001",
        }),
      );
      stream.pushEvent(
        createMessageCompletedEvent({
          message: "Bootstrap reply: Brooklyn",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_001",
        }),
      );
      stream.pushEvent(createTurnCompletedEvent({ sequence: 1, turnId: "turn_001" }));
      stream.pushEvent(createSessionWaitingEvent());
    }, 0);

    const result = await messagePromise;

    const messageHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const streamHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);

    expect(messageHeaders.get(VERCEL_PROTECTION_BYPASS_HEADER)).toBe("secret_123");
    expect(streamHeaders.get(VERCEL_PROTECTION_BYPASS_HEADER)).toBe("secret_123");
    expect(messageHeaders.get("authorization")).toBe("Basic dGVzdDpzZWNyZXQ=");
    expect(streamHeaders.get("authorization")).toBe("Basic dGVzdDpzZWNyZXQ=");
    expect(result.session).toEqual({
      boundaryCount: 1,
      continuationToken: "http:session_001",
      sessionId: "session_001",
      streamIndex: 5,
    });
  });

  it("hydrates local Vercel OIDC auth for both message and stream requests", async () => {
    const stream = createControlledStreamResponse();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        createStartedMessageResponse(
          "session_001",
          "http:session_001",
          createEveMessageStreamRoutePath("session_001"),
        ),
      )
      .mockResolvedValueOnce(stream.response);

    vi.mocked(getVercelOidcToken).mockResolvedValue("oidc_token_123");

    const messagePromise = sendDevelopmentMessage({
      message: "Brooklyn",
      serverUrl: "https://example.com",
      session: createDevelopmentSessionState(),
    });

    setTimeout(() => {
      stream.pushEvent(
        createTurnStartedEvent({
          sequence: 1,
          turnId: "turn_001",
        }),
      );
      stream.pushEvent(
        createMessageReceivedEvent({
          message: "Brooklyn",
          sequence: 1,
          turnId: "turn_001",
        }),
      );
      stream.pushEvent(
        createMessageCompletedEvent({
          message: "Bootstrap reply: Brooklyn",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_001",
        }),
      );
      stream.pushEvent(createTurnCompletedEvent({ sequence: 1, turnId: "turn_001" }));
      stream.pushEvent(createSessionWaitingEvent());
    }, 0);

    await messagePromise;

    const messageHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const streamHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);

    expect(messageHeaders.get("authorization")).toBe("Bearer oidc_token_123");
    expect(streamHeaders.get("authorization")).toBe("Bearer oidc_token_123");
    expect(messageHeaders.get(VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER)).toBe("oidc_token_123");
    expect(streamHeaders.get(VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER)).toBe("oidc_token_123");
    expect(getVercelOidcToken).toHaveBeenCalledTimes(2);
  });
});
