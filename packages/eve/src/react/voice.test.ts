import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

const realtimeOptions: any[] = [];

const realtimeState = {
  cancelResponse: vi.fn(),
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(),
  events: [],
  isCapturing: false,
  isPlaying: false,
  messages: [],
  requestResponse: vi.fn(),
  sendEvent: vi.fn(),
  startAudioCapture: vi.fn(),
  status: "disconnected",
  stopAudioCapture: vi.fn(),
  stopPlayback: vi.fn(),
};

vi.mock("@ai-sdk/react", () => ({
  experimental_useRealtime: (options: unknown) => {
    realtimeOptions.push(options);
    return realtimeState;
  },
}));

vi.mock("ai", () => ({
  __esModule: true,
}));

afterEach(() => {
  realtimeOptions.length = 0;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const SESSION_ID_HEADER = "x-eve-session-id";

function completedMessageEvent(message: string) {
  return {
    type: "message.completed",
    data: { finishReason: "stop", message, sequence: 1, stepIndex: 0, turnId: "turn-1" },
  };
}

function ndjsonResponse(events: readonly unknown[]): Response {
  const body = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

/**
 * Mocks the durable session API the voice hook now drives: a create/continue
 * POST that acknowledges immediately, followed by an NDJSON event stream.
 * Each entry in `turns` supplies the events for one turn, in order.
 */
function sessionFetchMock(turns: ReadonlyArray<{ sessionId: string; events: readonly unknown[] }>) {
  let streamedTurns = 0;
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const turn = turns[Math.min(streamedTurns, turns.length - 1)]!;

    if (method === "POST" && /\/eve\/v1\/session(\/[^/]+)?$/.test(url)) {
      return Response.json(
        { ok: true, sessionId: turn.sessionId, continuationToken: "eve:token" },
        { status: 202, headers: { [SESSION_ID_HEADER]: turn.sessionId } },
      );
    }
    if (method === "GET" && /\/stream(\?|$)/.test(url)) {
      const response = ndjsonResponse(turn.events);
      streamedTurns += 1;
      return response;
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
}

function postCalls(fetch: ReturnType<typeof vi.fn>): unknown[][] {
  return fetch.mock.calls.filter(
    (call) => ((call[1] as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "POST",
  );
}

function streamCalls(fetch: ReturnType<typeof vi.fn>): unknown[][] {
  return fetch.mock.calls.filter((call) => /\/stream(\?|$)/.test(String(call[0])));
}

describe("useEveVoice", () => {
  it("configures realtime with a stable voice session setup URL", async () => {
    const { useEveVoice } = await import("#react/voice.js");

    function TestComponent() {
      useEveVoice({ voiceSessionId: "voice-1" });
      return null;
    }

    act(() => {
      create(createElement(TestComponent));
    });

    expect(realtimeOptions).toHaveLength(1);
    expect(realtimeOptions[0].api.token).toBe(
      "/eve/v1/realtime-speech/setup?voiceSessionId=voice-1",
    );
    expect(realtimeOptions[0].model).toMatchObject({
      modelId: "openai/gpt-realtime-2",
      provider: "gateway.realtime",
      specificationVersion: "v4",
    });
    expect(realtimeOptions[0].sessionConfig.outputModalities).toEqual(["audio"]);
    expect(
      realtimeOptions[0].model.getWebSocketConfig({ token: "vcst_test", url: "wss://gateway" }),
    ).toEqual({
      protocols: ["ai-gateway-realtime.v1", "ai-gateway-auth.vcst_test"],
      url: "wss://gateway",
    });
  });

  it("bridges finalized transcription into durable session turns and speaks the reply", async () => {
    const fetch = sessionFetchMock([
      { sessionId: "session-1", events: [completedMessageEvent("Agent reply"), waiting()] },
      { sessionId: "session-1", events: [completedMessageEvent("Second reply"), waiting()] },
    ]);
    vi.stubGlobal("fetch", fetch);

    const { useEveVoice } = await import("#react/voice.js");
    const onReply = vi.fn();

    function TestComponent() {
      useEveVoice({ context: ["voice context"], onReply, voiceSessionId: "voice-1" });
      return null;
    }

    act(() => {
      create(createElement(TestComponent));
    });

    realtimeOptions[0].onEvent({
      itemId: "item-1",
      raw: {},
      transcript: "Hello over speech",
      type: "input-transcription-completed",
    });

    await vi.waitFor(() => expect(onReply).toHaveBeenCalled());

    // First turn creates the session and consumes its event stream.
    const firstPost = postCalls(fetch)[0]!;
    expect(String(firstPost[0])).toBe("/eve/v1/session");
    expect(JSON.parse((firstPost[1] as RequestInit).body as string)).toEqual({
      message: "Hello over speech",
      clientContext: ["voice context"],
    });

    expect(onReply).toHaveBeenCalledWith({
      message: "Hello over speech",
      sessionId: "session-1",
      streamIndex: 2,
      text: "Agent reply",
    });
    expect(realtimeState.sendEvent).toHaveBeenCalledWith({
      type: "conversation-item-create",
      item: { type: "text-message", role: "user", text: "EVE_SPEAK:\nAgent reply" },
    });
    expect(realtimeState.requestResponse).toHaveBeenCalledWith({ modalities: ["audio"] });

    // Second turn continues the same session and resumes the stream cursor.
    realtimeOptions[0].onEvent({
      itemId: "item-2",
      raw: {},
      transcript: "Second message",
      type: "input-transcription-completed",
    });

    await vi.waitFor(() => expect(postCalls(fetch)).toHaveLength(2));

    const secondPost = postCalls(fetch)[1]!;
    expect(String(secondPost[0])).toBe("/eve/v1/session/session-1");
    const secondStream = streamCalls(fetch).at(-1)!;
    expect(String(secondStream[0])).toContain("startIndex=2");
  });

  it("speaks the configured fallback when a turn fails without producing text", async () => {
    const fetch = sessionFetchMock([{ sessionId: "session-1", events: [sessionFailed()] }]);
    vi.stubGlobal("fetch", fetch);

    const { useEveVoice } = await import("#react/voice.js");
    const onReply = vi.fn();

    function TestComponent() {
      useEveVoice({
        fallbackReply: "Sorry, please try again.",
        onReply,
        voiceSessionId: "voice-1",
      });
      return null;
    }

    act(() => {
      create(createElement(TestComponent));
    });

    realtimeOptions[0].onEvent({
      itemId: "item-1",
      raw: {},
      transcript: "Hello",
      type: "input-transcription-completed",
    });

    await vi.waitFor(() =>
      expect(realtimeState.sendEvent).toHaveBeenCalledWith({
        type: "conversation-item-create",
        item: { type: "text-message", role: "user", text: "EVE_SPEAK:\nSorry, please try again." },
      }),
    );
    expect(onReply).not.toHaveBeenCalled();
  });

  it("ignores unsolicited model responses", async () => {
    const { useEveVoice } = await import("#react/voice.js");

    function TestComponent() {
      useEveVoice({ voiceSessionId: "voice-1" });
      return null;
    }

    act(() => {
      create(createElement(TestComponent));
    });

    realtimeOptions[0].onEvent({ raw: {}, responseId: "response-1", type: "response-created" });

    expect(realtimeState.cancelResponse).not.toHaveBeenCalled();
    expect(realtimeState.requestResponse).not.toHaveBeenCalled();
  });

  it("suppresses transcripts during an unsolicited model response", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { useEveVoice } = await import("#react/voice.js");

    function TestComponent() {
      useEveVoice({ voiceSessionId: "voice-1" });
      return null;
    }

    act(() => {
      create(createElement(TestComponent));
    });

    // A server-VAD auto-response we never solicited still marks a response in
    // flight, so its echoed-audio transcript must not start an Eve turn.
    realtimeOptions[0].onEvent({ raw: {}, responseId: "auto-1", type: "response-created" });
    realtimeOptions[0].onEvent({
      itemId: "echo-1",
      raw: {},
      transcript: "model echo",
      type: "input-transcription-completed",
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes each transcript's own itemId to onTranscript", async () => {
    const { useEveVoice } = await import("#react/voice.js");
    const seen: Array<{ itemId: string; transcript: string }> = [];

    function TestComponent() {
      useEveVoice({
        voiceSessionId: "voice-1",
        onTranscript: ({ itemId, transcript }) => {
          seen.push({ itemId, transcript });
        },
      });
      return null;
    }

    act(() => {
      create(createElement(TestComponent));
    });

    // Both finalize before the serialized turn queue drains; each turn must
    // report the itemId captured at enqueue time, not the latest one.
    realtimeOptions[0].onEvent({
      itemId: "item-1",
      raw: {},
      transcript: "first",
      type: "input-transcription-completed",
    });
    realtimeOptions[0].onEvent({
      itemId: "item-2",
      raw: {},
      transcript: "second",
      type: "input-transcription-completed",
    });

    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen).toEqual([
      { itemId: "item-1", transcript: "first" },
      { itemId: "item-2", transcript: "second" },
    ]);
  });

  it("suppresses transcriptions that arrive while the Eve reply is speaking", async () => {
    const fetch = sessionFetchMock([
      { sessionId: "session-1", events: [completedMessageEvent("Agent reply"), waiting()] },
    ]);
    vi.stubGlobal("fetch", fetch);
    const { useEveVoice } = await import("#react/voice.js");

    function TestComponent() {
      useEveVoice({ voiceSessionId: "voice-1" });
      return null;
    }

    act(() => {
      create(createElement(TestComponent));
    });

    realtimeOptions[0].onEvent({
      itemId: "item-1",
      raw: {},
      transcript: "First utterance",
      type: "input-transcription-completed",
    });
    await vi.waitFor(() => expect(postCalls(fetch)).toHaveLength(1));

    realtimeOptions[0].onEvent({ raw: {}, responseId: "response-1", type: "response-created" });
    realtimeOptions[0].onEvent({
      itemId: "item-2",
      raw: {},
      transcript: "Agent reply",
      type: "input-transcription-completed",
    });

    expect(postCalls(fetch)).toHaveLength(1);
  });

  it("ignores empty transcription completions", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { useEveVoice } = await import("#react/voice.js");

    function TestComponent() {
      useEveVoice({ voiceSessionId: "voice-1" });
      return null;
    }

    act(() => {
      create(createElement(TestComponent));
    });

    realtimeOptions[0].onEvent({
      itemId: "empty-item",
      raw: {},
      transcript: "   ",
      type: "input-transcription-completed",
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("releases the microphone and skips capture when the realtime connection fails", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    realtimeState.connect.mockImplementationOnce(async () => {
      realtimeOptions[0].onError(new Error("realtime offline"));
    });

    const { useEveVoice } = await import("#react/voice.js");
    const onError = vi.fn();
    let voice: ReturnType<typeof useEveVoice> | undefined;
    function TestComponent() {
      voice = useEveVoice({ onError, voiceSessionId: "voice-1" });
      return null;
    }

    act(() => {
      create(createElement(TestComponent));
    });

    await act(async () => {
      await voice!.start();
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(realtimeState.startAudioCapture).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "realtime offline" }));
  });

  it("ignores re-entrant start() calls while a connection is in flight", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const { useEveVoice } = await import("#react/voice.js");
    let voice: ReturnType<typeof useEveVoice> | undefined;
    function TestComponent() {
      voice = useEveVoice({ voiceSessionId: "voice-1" });
      return null;
    }

    act(() => {
      create(createElement(TestComponent));
    });

    // The second call is synchronous, before the first start() resolves its
    // microphone request, so the re-entrancy guard must short-circuit it.
    await act(async () => {
      await Promise.all([voice!.start(), voice!.start()]);
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(realtimeState.connect).toHaveBeenCalledTimes(1);
    expect(realtimeState.startAudioCapture).toHaveBeenCalledTimes(1);
  });

  it("releases the microphone when a realtime error surfaces after connecting", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const { useEveVoice } = await import("#react/voice.js");
    let voice: ReturnType<typeof useEveVoice> | undefined;
    function TestComponent() {
      voice = useEveVoice({ voiceSessionId: "voice-1" });
      return null;
    }

    act(() => {
      create(createElement(TestComponent));
    });

    await act(async () => {
      await voice!.start();
    });

    expect(realtimeState.startAudioCapture).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();

    act(() => {
      realtimeOptions[0].onError(new Error("socket dropped"));
    });

    expect(realtimeState.stopAudioCapture).toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

function waiting() {
  return { type: "session.waiting", data: { wait: "next-user-message" } };
}

function sessionFailed() {
  return { type: "session.failed", data: { reason: "boom" } };
}
