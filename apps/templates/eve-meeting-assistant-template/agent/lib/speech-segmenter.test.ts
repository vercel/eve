import { describe, expect, it } from "vitest";

import { SpeechSegmenter, type SpeechSegment } from "./speech-segmenter.js";

const CHAT = "Alice (in chat):\nopen a ticket";
const SPOKEN = "Alice: eve, who's assigned this?";

function segmenter(options?: { resumed?: boolean }) {
  const said: SpeechSegment[] = [];
  return { said, speech: new SpeechSegmenter((segment) => said.push(segment), options) };
}

function stream(speech: SpeechSegmenter, turnId: string, partId: string, chunks: string[]) {
  chunks.forEach((delta, index) =>
    speech.delta(turnId, { delta, partId, ...(index === 0 && { kind: "text" }) }),
  );
  speech.complete(turnId, partId, chunks.join(""));
}

describe("SpeechSegmenter", () => {
  it("speaks a [voice] message sentence by sentence", () => {
    const { said, speech } = segmenter();
    speech.heard("t1", [SPOKEN]);
    stream(speech, "t1", "p1", ["[voice] Bob is", ". He started ", "today."]);
    expect(said).toEqual([
      { partId: "p1", text: "Bob is.", turnId: "t1" },
      { partId: "p1", text: "He started today.", turnId: "t1" },
    ]);
  });

  it("never speaks a [chat] message, even after a leading newline or an empty chunk", () => {
    for (const first of ["\n", "", " "]) {
      const { said, speech } = segmenter();
      speech.heard("t1", [SPOKEN]);
      stream(speech, "t1", "p1", [first, "[chat] Opened ENG-1: https://linear.app/x. Done."]);
      expect(said).toEqual([]);
    }
  });

  it("keeps untagged text out of the room for a chat-only turn", () => {
    const { said, speech } = segmenter();
    speech.heard("t1", [CHAT]);
    stream(speech, "t1", "p1", ["Opened ENG-1. ", "Anything else?"]);
    expect(said).toEqual([]);
  });

  it("speaks untagged text for a spoken turn and for a turn it didn't see start", () => {
    const { said, speech } = segmenter();
    speech.heard("t1", [CHAT]);
    speech.heard("t1", [SPOKEN]);
    stream(speech, "t1", "p1", ["Bob is."]);
    stream(speech, "t2", "p2", ["Alice is."]);
    expect(said.map(({ text }) => text)).toEqual(["Bob is.", "Alice is."]);
  });

  it("drops links and Markdown from speech", () => {
    const { said, speech } = segmenter();
    stream(speech, "t1", "p1", ["[both] See **[ENG-1](https://linear.app/x)** now."]);
    expect(said.map(({ text }) => text)).toEqual(["See ENG-1 now."]);
  });

  it("speaks a message it missed the start of from its final text, unless resuming", () => {
    const fresh = segmenter();
    fresh.speech.delta("t1", { delta: " started today.", partId: "p1" });
    fresh.speech.complete("t1", "p1", "[voice] Bob is. He started today.");
    expect(fresh.said.map(({ text }) => text)).toEqual(["Bob is. He started today."]);

    const resumed = segmenter({ resumed: true });
    resumed.speech.delta("t1", { delta: " started today.", partId: "p1" });
    resumed.speech.complete("t1", "p1", "[voice] Bob is. He started today.");
    expect(resumed.said).toEqual([]);
  });
});
