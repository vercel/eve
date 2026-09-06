import { MockSpeechModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { synthesizeSpeech } from "#internal/voice/synthesize.js";

describe("synthesizeSpeech", () => {
  it("forwards text and voice to the model and returns audio bytes", async () => {
    const audioBytes = new Uint8Array([9, 8, 7]);
    let received: { text?: string; voice?: string } = {};
    const model = new MockSpeechModelV3({
      modelId: "openai/tts-1",
      doGenerate: async (options) => {
        received = { text: options.text, voice: options.voice };
        return {
          audio: audioBytes,
          warnings: [],
          response: { timestamp: new Date(), modelId: "openai/tts-1" },
        };
      },
    });

    const result = await synthesizeSpeech({
      model,
      text: "Hello there.",
      voice: "alloy",
      outputFormat: "mp3",
    });

    expect(result.audio).toEqual(audioBytes);
    expect(received).toEqual({ text: "Hello there.", voice: "alloy" });
  });
});
