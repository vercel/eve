import { describe, expect, it, vi } from "vitest";

import { Client } from "#client/client.js";
import { setupVoice, voiceSetupUrl } from "#client/voice.js";

describe("voiceSetupUrl", () => {
  it("appends the voice session id to a relative setup route", () => {
    expect(voiceSetupUrl("/eve/v1/realtime-speech/setup", "voice-1")).toBe(
      "/eve/v1/realtime-speech/setup?voiceSessionId=voice-1",
    );
  });

  it("appends the voice session id to an absolute setup route", () => {
    expect(voiceSetupUrl("https://eve.example.com/eve/v1/realtime-speech/setup", "voice-1")).toBe(
      "https://eve.example.com/eve/v1/realtime-speech/setup?voiceSessionId=voice-1",
    );
  });
});

describe("setupVoice", () => {
  it("mints a realtime token through the setup route with the voice session id", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        expiresAt: 1_700_000_060,
        token: "vcst_test",
        url: "wss://gateway.example/realtime-model",
        voiceSessionId: "voice-1",
      }),
    );

    const result = await setupVoice({ fetch }, { voiceSessionId: "voice-1" });

    expect(fetch).toHaveBeenCalledWith(
      "/eve/v1/realtime-speech/setup?voiceSessionId=voice-1",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).toEqual({
      expiresAt: 1_700_000_060,
      token: "vcst_test",
      url: "wss://gateway.example/realtime-model",
      voiceSessionId: "voice-1",
    });
  });

  it("throws when the setup response is malformed", async () => {
    const fetch = vi.fn(async () => Response.json({ token: "vcst_test" }));
    await expect(setupVoice({ fetch }, { voiceSessionId: "voice-1" })).rejects.toThrow(/malformed/);
  });

  it("works against an authenticated Eve client and a remote host", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        token: "vcst_client",
        url: "wss://gateway.example/realtime-model",
        voiceSessionId: "voice-client",
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const client = new Client({ auth: { bearer: "test-token" }, host: "https://eve.example.com" });
    await setupVoice(client, { voiceSessionId: "voice-client" });

    expect(fetch).toHaveBeenCalledWith(
      "https://eve.example.com/eve/v1/realtime-speech/setup?voiceSessionId=voice-client",
      expect.objectContaining({ method: "POST" }),
    );
    const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer test-token");

    vi.unstubAllGlobals();
  });
});
