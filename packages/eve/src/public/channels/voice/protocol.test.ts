import { describe, expect, it } from "vitest";

import {
  parseVoiceClientMessage,
  serializeVoiceServerMessage,
} from "#public/channels/voice/protocol.js";

describe("parseVoiceClientMessage", () => {
  it("parses a barge_in control message", () => {
    expect(parseVoiceClientMessage('{"type":"barge_in"}')).toEqual({ type: "barge_in" });
  });

  it("parses a text control message", () => {
    expect(parseVoiceClientMessage('{"type":"text","text":"hello"}')).toEqual({
      type: "text",
      text: "hello",
    });
  });

  it("returns null for malformed JSON", () => {
    expect(parseVoiceClientMessage("not json")).toBeNull();
  });

  it("returns null for an unknown message type", () => {
    expect(parseVoiceClientMessage('{"type":"nope"}')).toBeNull();
  });

  it("returns null for a text message missing its text field", () => {
    expect(parseVoiceClientMessage('{"type":"text"}')).toBeNull();
  });

  it("returns null for a non-object payload", () => {
    expect(parseVoiceClientMessage("42")).toBeNull();
  });
});

describe("serializeVoiceServerMessage", () => {
  it("serializes a server message to JSON", () => {
    expect(serializeVoiceServerMessage({ type: "ready", audioFormat: "mp3" })).toBe(
      '{"type":"ready","audioFormat":"mp3"}',
    );
  });

  it("round-trips through JSON.parse", () => {
    const message = { type: "status", state: "speaking" } as const;
    expect(JSON.parse(serializeVoiceServerMessage(message))).toEqual(message);
  });
});
