import type { FilePart, ModelMessage, UserContent } from "ai";
import { describe, expect, it } from "vitest";
import { coalesceTurnInputs, resolveAssistantStepText } from "#harness/messages.js";
import type { StepInput } from "#harness/types.js";

function textFilePart(overrides: {
  readonly filename: string;
  readonly payload: string;
}): FilePart {
  return {
    data: Buffer.from(overrides.payload, "utf8"),
    filename: overrides.filename,
    mediaType: "text/plain",
    type: "file",
  };
}

describe("coalesceTurnInputs", () => {
  it("joins two messages with a double newline", () => {
    const result = coalesceTurnInputs({ message: "hello" }, { message: "world" });

    expect(result).toEqual({ message: "hello\n\nworld" });
  });

  it("reduces three messages sequentially", () => {
    const messages: StepInput[] = [{ message: "a" }, { message: "b" }, { message: "c" }];
    const result = messages.reduce(coalesceTurnInputs);

    expect(result).toEqual({ message: "a\n\nb\n\nc" });
  });

  it("merges inputResponses from both payloads", () => {
    const result = coalesceTurnInputs(
      { inputResponses: [{ requestId: "r1", optionId: "approve" }] },
      { inputResponses: [{ requestId: "r2", text: "yes" }] },
    );

    expect(result).toEqual({
      inputResponses: [
        { requestId: "r1", optionId: "approve" },
        { requestId: "r2", text: "yes" },
      ],
    });
  });

  it("combines messages and inputResponses", () => {
    const result = coalesceTurnInputs(
      { message: "hello", inputResponses: [{ requestId: "r1", optionId: "approve" }] },
      { message: "world" },
    );

    expect(result).toEqual({
      inputResponses: [{ requestId: "r1", optionId: "approve" }],
      message: "hello\n\nworld",
    });
  });

  it("preserves context from both payloads in order", () => {
    const result = coalesceTurnInputs(
      {
        message: "hello",
        context: ["from-channel"],
      },
      {
        inputResponses: [{ requestId: "r1", text: "yes" }],
        context: ["from-hook"],
      },
    );

    expect(result).toEqual({
      inputResponses: [{ requestId: "r1", text: "yes" }],
      message: "hello",
      context: ["from-channel", "from-hook"],
    });
  });

  it("returns b when a.message is undefined (UserContent array preserved)", () => {
    const attachment = textFilePart({ filename: "notes.txt", payload: "hi" });
    const b: StepInput = { message: [{ type: "text", text: "summary" }, attachment] };
    const result = coalesceTurnInputs({}, b);

    expect(result.message).toBe(b.message);
  });

  it("promotes a string when the other side is a UserContent array", () => {
    const attachment = textFilePart({ filename: "notes.txt", payload: "hi" });
    const result = coalesceTurnInputs(
      { message: "preface" },
      { message: [{ type: "text", text: "payload" }, attachment] },
    );

    expect(Array.isArray(result.message)).toBe(true);
    const merged = result.message as UserContent;
    expect(merged).toHaveLength(3);
    expect(merged[0]).toEqual({ type: "text", text: "preface" });
    expect(merged[1]).toEqual({ type: "text", text: "payload" });
    expect(merged[2]).toBe(attachment);
  });

  it("concatenates two UserContent arrays part-by-part", () => {
    const first = textFilePart({ filename: "a.txt", payload: "a" });
    const second = textFilePart({ filename: "b.txt", payload: "b" });
    const result = coalesceTurnInputs(
      { message: [{ type: "text", text: "first" }, first] },
      { message: [{ type: "text", text: "second" }, second] },
    );

    const merged = result.message as UserContent;
    expect(merged).toHaveLength(4);
    expect(merged[0]).toEqual({ type: "text", text: "first" });
    expect(merged[1]).toBe(first);
    expect(merged[2]).toEqual({ type: "text", text: "second" });
    expect(merged[3]).toBe(second);
  });

  it("drops an empty string when the other side is a UserContent array", () => {
    const attachment = textFilePart({ filename: "notes.txt", payload: "hi" });
    const result = coalesceTurnInputs({ message: "" }, { message: [attachment] });

    const merged = result.message as UserContent;
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(attachment);
  });
});

describe("resolveAssistantStepText", () => {
  it("extracts text from a string-content assistant message", () => {
    const messages: ModelMessage[] = [{ content: "Hello!", role: "assistant" }];

    expect(resolveAssistantStepText(messages, undefined)).toBe("Hello!");
  });

  it("extracts text from content-part array messages", () => {
    const messages: ModelMessage[] = [
      {
        content: [
          { text: "Part one.", type: "text" },
          { input: {}, toolCallId: "call-1", toolName: "tool", type: "tool-call" },
          { text: " Part two.", type: "text" },
        ],
        role: "assistant",
      },
    ];

    expect(resolveAssistantStepText(messages, undefined)).toBe("Part one. Part two.");
  });

  it("returns text from the last assistant message when a step has multiple replies", () => {
    const messages: ModelMessage[] = [
      { content: "First.", role: "assistant" },
      { content: "Second.", role: "assistant" },
    ];

    expect(resolveAssistantStepText(messages, undefined)).toBe("Second.");
  });

  it("skips non-assistant messages", () => {
    const messages: ModelMessage[] = [
      { content: "user message", role: "user" },
      { content: "Reply.", role: "assistant" },
    ];

    expect(resolveAssistantStepText(messages, undefined)).toBe("Reply.");
  });

  it("falls back to the provided fallback when no assistant text exists", () => {
    const messages: ModelMessage[] = [
      {
        content: [{ input: {}, toolCallId: "call-1", toolName: "tool", type: "tool-call" }],
        role: "assistant",
      },
    ];

    expect(resolveAssistantStepText(messages, "fallback text")).toBe("fallback text");
  });

  it("returns null when there is no text and no fallback", () => {
    expect(resolveAssistantStepText([], undefined)).toBeNull();
  });

  it("returns null when the fallback is empty", () => {
    expect(resolveAssistantStepText([], "")).toBeNull();
  });
});
