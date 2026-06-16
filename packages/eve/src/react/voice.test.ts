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

  it("bridges finalized transcription to the Eve turn route with the stream cursor", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          continuationToken: "voice-1",
          sessionId: "session-1",
          streamIndex: 4,
          text: "Agent reply",
          voiceSessionId: "voice-1",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          continuationToken: "voice-1",
          sessionId: "session-1",
          streamIndex: 7,
          text: "Second reply",
          voiceSessionId: "voice-1",
        }),
      );
    vi.stubGlobal("fetch", fetch);

    const { useEveVoice } = await import("#react/voice.js");
    const onReply = vi.fn();

    function TestComponent() {
      useEveVoice({
        context: ["voice context"],
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
      transcript: "Hello over speech",
      type: "input-transcription-completed",
    });

    await vi.waitFor(() => expect(onReply).toHaveBeenCalled());

    expect(fetch).toHaveBeenCalledWith(
      "/eve/v1/realtime-speech/turn",
      expect.objectContaining({
        body: JSON.stringify({
          context: ["voice context"],
          message: "Hello over speech",
          streamIndex: 0,
          voiceSessionId: "voice-1",
        }),
        method: "POST",
      }),
    );
    expect(onReply).toHaveBeenCalledWith({
      message: "Hello over speech",
      sessionId: "session-1",
      streamIndex: 4,
      text: "Agent reply",
    });
    expect(realtimeState.sendEvent).toHaveBeenCalledWith({
      type: "conversation-item-create",
      item: {
        type: "text-message",
        role: "user",
        text: "EVE_SPEAK:\nAgent reply",
      },
    });
    expect(realtimeState.requestResponse).toHaveBeenCalledWith({ modalities: ["audio"] });
    expect(realtimeState.cancelResponse).not.toHaveBeenCalled();

    realtimeOptions[0].onEvent({
      itemId: "item-2",
      raw: {},
      transcript: "Second message",
      type: "input-transcription-completed",
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    const secondRequest = (fetch as ReturnType<typeof vi.fn>).mock.calls[1]![1] as RequestInit;
    expect(JSON.parse(secondRequest.body as string)).toMatchObject({
      message: "Second message",
      sessionId: "session-1",
      streamIndex: 4,
      voiceSessionId: "voice-1",
    });
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

  it("suppresses transcriptions that arrive while the Eve reply is speaking", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        continuationToken: "voice-1",
        sessionId: "session-1",
        streamIndex: 1,
        text: "Agent reply",
        voiceSessionId: "voice-1",
      }),
    );
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
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    realtimeOptions[0].onEvent({ raw: {}, responseId: "response-1", type: "response-created" });
    realtimeOptions[0].onEvent({
      itemId: "item-2",
      raw: {},
      transcript: "Agent reply",
      type: "input-transcription-completed",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
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
});

describe("VoiceButton", () => {
  it("renders an accessible microphone toggle", async () => {
    const { VoiceButton } = await import("#react/voice.js");

    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(createElement(VoiceButton, { className: "voice" }));
    });

    const button = tree!.root.findByType("button");
    expect(button.props["aria-label"]).toBe("Start voice");
    expect(button.props.className).toBe("voice");
    expect(button.props["data-voice-state"]).toBe("ready");
    expect(button.props.type).toBe("button");
  });
});
