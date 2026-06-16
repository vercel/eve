import { describe, expect, it, vi } from "vitest";

import { Client } from "#client/client.js";
import { EveVoiceSession } from "#client/voice.js";

describe("EveVoiceSession", () => {
  it("builds a stable setup URL for the voice session", () => {
    const session = new EveVoiceSession({ voiceSessionId: "voice-1" });
    expect(session.setupUrl).toBe("/eve/v1/realtime-speech/setup?voiceSessionId=voice-1");
  });

  it("sends finalized transcripts with the session cursor and advances state", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        continuationToken: "voice-1",
        sessionId: "session-1",
        streamIndex: 3,
        text: "Agent reply",
        voiceSessionId: "voice-1",
      }),
    );
    const session = new EveVoiceSession({ fetch, voiceSessionId: "voice-1" });

    const result = await session.sendTranscript({
      context: ["voice context"],
      message: "Hello",
    });

    expect(fetch).toHaveBeenCalledWith(
      "/eve/v1/realtime-speech/turn",
      expect.objectContaining({
        body: JSON.stringify({
          context: ["voice context"],
          message: "Hello",
          sessionId: undefined,
          streamIndex: 0,
          voiceSessionId: "voice-1",
        }),
      }),
    );
    expect(result.text).toBe("Agent reply");
    expect(session.state).toEqual({
      sessionId: "session-1",
      streamIndex: 3,
      voiceSessionId: "voice-1",
    });
  });

  it("can be created from the authenticated Eve client", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        continuationToken: "voice-client",
        sessionId: "session-client",
        streamIndex: 2,
        text: "Client reply",
        voiceSessionId: "voice-client",
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const client = new Client({
      auth: { bearer: "test-token" },
      host: "https://eve.example.com",
    });
    const session = client.voiceSession("voice-client");
    await session.sendTranscript("Hello from a TUI");

    expect(fetch).toHaveBeenCalledWith(
      "https://eve.example.com/eve/v1/realtime-speech/turn",
      expect.objectContaining({
        headers: expect.any(Headers),
        method: "POST",
      }),
    );
    const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer test-token");
  });
});
