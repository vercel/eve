import { MockTranscriptionModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { transcribeAudio } from "#internal/voice/transcribe.js";

describe("transcribeAudio", () => {
  it("forwards audio to the model and maps the transcript result", async () => {
    let receivedAudio: unknown;
    const model = new MockTranscriptionModelV3({
      modelId: "openai/whisper-1",
      doGenerate: async (options) => {
        receivedAudio = options.audio;
        return {
          text: "hello world",
          segments: [],
          language: "en",
          durationInSeconds: 1.5,
          warnings: [],
          response: { timestamp: new Date(), modelId: "openai/whisper-1" },
        };
      },
    });

    const audio = new Uint8Array([1, 2, 3]);
    const result = await transcribeAudio({ model, audio });

    expect(result).toEqual({ text: "hello world", language: "en", durationInSeconds: 1.5 });
    expect(receivedAudio).toBe(audio);
  });
});
