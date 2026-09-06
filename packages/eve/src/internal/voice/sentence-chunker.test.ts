import { describe, expect, it } from "vitest";

import { createSentenceChunker } from "#internal/voice/sentence-chunker.js";

describe("createSentenceChunker", () => {
  it("emits a chunk once a sentence terminator is followed by whitespace", () => {
    const chunker = createSentenceChunker();
    expect(chunker.push("Hello there. ")).toEqual(["Hello there."]);
  });

  it("buffers across deltas until a sentence completes", () => {
    const chunker = createSentenceChunker();
    expect(chunker.push("Hello")).toEqual([]);
    expect(chunker.push(" there")).toEqual([]);
    expect(chunker.push(". How are you? ")).toEqual(["Hello there.", "How are you?"]);
  });

  it("waits for the character after a terminator so decimals stay intact", () => {
    const chunker = createSentenceChunker();
    // Trailing "3." must not be spoken as its own sentence.
    expect(chunker.push("Pi is 3.")).toEqual([]);
    expect(chunker.push("14 exactly. ")).toEqual(["Pi is 3.14 exactly."]);
  });

  it("does not split unspaced decimals mid-stream", () => {
    const chunker = createSentenceChunker();
    expect(chunker.push("It costs 3.14 dollars today. ")).toEqual(["It costs 3.14 dollars today."]);
  });

  it("treats a newline as a boundary", () => {
    const chunker = createSentenceChunker();
    expect(chunker.push("First line\nSecond")).toEqual(["First line"]);
  });

  it("keeps closing quotes with the sentence", () => {
    const chunker = createSentenceChunker();
    expect(chunker.push('She said "go." ')).toEqual(['She said "go."']);
  });

  it("merges too-short fragments into the following sentence", () => {
    const chunker = createSentenceChunker({ minChunkLength: 3 });
    expect(chunker.push("A. Longer sentence here. ")).toEqual(["A. Longer sentence here."]);
  });

  it("flushes the trailing remainder that never hit a boundary", () => {
    const chunker = createSentenceChunker();
    expect(chunker.push("Final words without punctuation")).toEqual([]);
    expect(chunker.flush()).toBe("Final words without punctuation");
  });

  it("returns null from flush when nothing is buffered", () => {
    const chunker = createSentenceChunker();
    chunker.push("Done. ");
    expect(chunker.flush()).toBeNull();
  });

  it("handles multiple sentences in a single delta", () => {
    const chunker = createSentenceChunker();
    expect(chunker.push("One. Two! Three? ")).toEqual(["One.", "Two!", "Three?"]);
  });
});
