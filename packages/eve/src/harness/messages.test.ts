import type { ModelMessage, UserContent } from "ai";
import type { DeliverHookPayload } from "#channel/types.js";

import type { MessageFilePart } from "#shared/message-content.js";
import type { HarnessStepInput } from "#harness/types.js";
import { describe, expect, it } from "vitest";
import {
  coalesceDeliveries,
  coalesceTurnInputs,
  createFrameworkUserMessage,
  createUserMessage,
  isFrameworkMessageKind,
  isFrameworkUserMessage,
  isUserMessageKind,
  isUserModelMessage,
  markFrameworkStepInput,
  normalizeModelMessages,
  normalizeMessage,
  resolveAssistantStepText,
  selectDeliveryPayloads,
  validateHarnessModelMessages,
} from "#harness/messages.js";
import type { StepInput } from "#harness/types.js";
import { attachClientContext, readClientContext } from "#internal/client-context.js";

function textFilePart(overrides: {
  readonly filename: string;
  readonly payload: string;
}): MessageFilePart {
  return {
    data: Buffer.from(overrides.payload, "utf8"),
    filename: overrides.filename,
    mediaType: "text/plain",
    type: "file",
  };
}

describe("coalesceDeliveries", () => {
  const caller = {
    callId: "call-1",
    replyTo: { kind: "hook" as const, token: "turn-caller" },
    subagentName: "research",
  };

  it("preserves the only caller in a delivery batch", () => {
    expect(
      coalesceDeliveries([
        { kind: "deliver", payloads: [{ context: ["earlier context"] }] },
        { caller, kind: "deliver", payloads: [{ message: "question" }] },
      ]),
    ).toEqual({
      caller,
      kind: "deliver",
      payloads: [{ context: ["earlier context"] }, { message: "question" }],
    });
  });

  it("preserves receipt identities through filtering and rebatching", () => {
    const metadata = (deliveryId: string) => ({
      channelKind: "subagent",
      channelName: "research",
      deliveryId,
      payloadIndex: 0,
    });
    const batch = coalesceDeliveries<DeliverHookPayload>([
      {
        kind: "deliver" as const,
        caller,
        payloads: [{ message: "First." }],
        deliveryMetadata: [metadata("d1")],
      },
      {
        kind: "deliver" as const,
        payloads: [{ message: "A person's correction." }],
        deliveryMetadata: [metadata("d2")],
      },
      {
        kind: "deliver" as const,
        caller,
        payloads: [{ message: "Second." }],
        deliveryMetadata: [metadata("d3")],
      },
    ]);
    const selected = selectDeliveryPayloads(batch, [
      { index: 2, payload: batch.payloads[2]! },
      { index: 1, payload: batch.payloads[1]! },
    ]);
    const replayed: typeof selected = JSON.parse(JSON.stringify(selected));
    const latest = {
      ...caller,
      replyTo: { kind: "hook" as const, token: "third-reply" },
    };
    const result = coalesceDeliveries<DeliverHookPayload>([
      replayed,
      {
        kind: "deliver" as const,
        caller: latest,
        payloads: [{ message: "Third." }],
        deliveryMetadata: [metadata("d4")],
      },
    ]);
    expect(result.caller).toEqual(latest);
    expect(
      result.deliveryMetadata?.map(({ deliveryId, payloadIndex }) => ({
        deliveryId,
        payloadIndex,
      })),
    ).toEqual([
      { deliveryId: "d3", payloadIndex: 0 },
      { deliveryId: "d2", payloadIndex: 1 },
      { deliveryId: "d4", payloadIndex: 2 },
    ]);
  });

  it("rejects a batch with more than one turn caller", () => {
    expect(() =>
      coalesceDeliveries([
        { caller, kind: "deliver", payloads: [{ message: "first" }] },
        {
          caller: { ...caller, callId: "call-2" },
          kind: "deliver",
          payloads: [{ message: "second" }],
        },
      ]),
    ).toThrow("Cannot coalesce deliveries from different turns.");
  });

  it("reindexes all delivery metadata while coalescing", () => {
    const metadata = (deliveryId: string) => ({
      channelKind: "channel:slack",
      channelName: "slack",
      deliveryId,
      payloadIndex: 0,
    });

    const result = coalesceDeliveries([
      {
        deliveryMetadata: [metadata("delivery-1")],
        kind: "deliver" as const,
        payloads: [{ message: "first" }],
      },
      {
        deliveryMetadata: [metadata("delivery-2")],
        kind: "deliver" as const,
        payloads: [{ message: "second" }],
      },
    ]);

    expect(result.deliveryMetadata).toEqual([
      metadata("delivery-1"),
      { ...metadata("delivery-2"), payloadIndex: 1 },
    ]);
  });
});

describe("coalesceTurnInputs", () => {
  it("keeps answers that carry their responder", () => {
    const bob = {
      attributes: {},
      authenticator: "test",
      principalId: "bob",
      principalType: "user",
    };
    const first = {
      deliveryId: "d1",
      interactionId: "approval-1",
      optionId: "approve",
      responseId: "r1",
    };
    const second = {
      deliveryId: "d2",
      interactionId: "approval-2",
      optionId: "cancel",
      responder: bob,
      responseId: "r2",
    };

    expect(coalesceTurnInputs({ answers: [first] }, { answers: [second] })).toEqual({
      answers: [first, second],
    });
  });

  it("joins two messages with a double newline", () => {
    const result = coalesceTurnInputs({ message: "hello" }, { message: "world" });

    expect(result).toEqual({ message: "hello\n\nworld" });
  });

  it("reduces three messages sequentially", () => {
    const messages: StepInput[] = [{ message: "a" }, { message: "b" }, { message: "c" }];
    const result = messages.reduce(coalesceTurnInputs);

    expect(result).toEqual({ message: "a\n\nb\n\nc" });
  });

  it("preserves a framework kind only when all merged message content shares it", () => {
    expect(
      coalesceTurnInputs(
        markFrameworkStepInput({ message: "first" }, "execution.continuation"),
        markFrameworkStepInput({ message: "second" }, "execution.continuation"),
      ),
    ).toEqual(markFrameworkStepInput({ message: "first\n\nsecond" }, "execution.continuation"));
    expect(
      coalesceTurnInputs(markFrameworkStepInput({ message: "first" }, "execution.continuation"), {
        message: "second",
      }),
    ).toEqual({ message: "first\n\nsecond" });
    expect(
      coalesceTurnInputs(
        markFrameworkStepInput({ message: "first" }, "context.instruction"),
        markFrameworkStepInput({ message: "second" }, "execution.continuation"),
      ),
    ).toEqual({ message: "first\n\nsecond" });
  });

  it("merges answers from both payloads", () => {
    const result = coalesceTurnInputs(
      { answers: [{ interactionId: "r1", optionId: "approve" }] },
      { answers: [{ interactionId: "r2", text: "yes" }] },
    );

    expect(result).toEqual({
      answers: [
        { interactionId: "r1", optionId: "approve" },
        { interactionId: "r2", text: "yes" },
      ],
    });
  });

  it("coalesces ephemeral context without making it durable context", () => {
    const result = coalesceTurnInputs<HarnessStepInput>(
      attachClientContext({}, ["first"]),
      attachClientContext({}, ["second"]),
    );

    expect(readClientContext(result)).toEqual(["first", "second"]);
    expect(result.context).toBeUndefined();
  });

  it("combines messages and answers", () => {
    const result = coalesceTurnInputs(
      { message: "hello", answers: [{ interactionId: "r1", optionId: "approve" }] },
      { message: "world" },
    );

    expect(result).toEqual({
      answers: [{ interactionId: "r1", optionId: "approve" }],
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
        answers: [{ interactionId: "r1", text: "yes" }],
        context: ["from-hook"],
      },
    );

    expect(result).toEqual({
      answers: [{ interactionId: "r1", text: "yes" }],
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

  it("drops blank text when coalescing structured content", () => {
    const attachment = textFilePart({ filename: "notes.txt", payload: "hi" });
    const result = coalesceTurnInputs(
      { message: [{ text: " \n\t", type: "text" }, attachment] },
      { message: " " },
    );

    expect(result.message).toEqual([attachment]);
  });
});

describe("normalizeMessage", () => {
  it.each([
    ["empty string", ""],
    ["whitespace-only string", "   \n\t "],
    ["empty content array", []],
    ["structured empty text", [{ text: "", type: "text" }]],
    ["structured whitespace-only text", [{ text: " \n\t", type: "text" }]],
  ] satisfies ReadonlyArray<readonly [string, string | UserContent]>)(
    "returns undefined for %s",
    (_name, content) => {
      expect(normalizeMessage(content)).toBeUndefined();
    },
  );

  it("preserves visible text", () => {
    expect(normalizeMessage("hello")).toBe("hello");
  });

  it("keeps file parts while removing blank text parts", () => {
    const attachment = textFilePart({ filename: "notes.txt", payload: "contents" });

    expect(
      normalizeMessage([{ text: "", type: "text" }, attachment, { text: "  ", type: "text" }]),
    ).toEqual([attachment]);
  });

  it("removes a blank string coalesced with structured content", () => {
    const attachment = textFilePart({ filename: "notes.txt", payload: "contents" });

    expect(coalesceTurnInputs({ message: [attachment] }, { message: " " }).message).toEqual([
      attachment,
    ]);
  });
});

describe("normalizeModelMessages", () => {
  it("drops blank text without removing meaningful structured content", () => {
    const toolCall = {
      input: {},
      toolCallId: "call-1",
      toolName: "probe",
      type: "tool-call" as const,
    };
    const visible = { content: "Keep me", role: "user" as const };

    expect(
      normalizeModelMessages([
        { content: " ", role: "assistant" },
        { content: [{ text: "", type: "text" }, toolCall], role: "assistant" },
        visible,
      ]),
    ).toEqual([{ content: [toolCall], role: "assistant" }, visible]);
  });
});

describe("createFrameworkUserMessage", () => {
  it.each([
    "context.instruction",
    "context.state",
    "context.compaction",
    "memory.load",
    "execution.continuation",
    "execution.continuation",
    "execution.retry",
  ] as const)("recognizes %s as a framework message kind", (kind) => {
    expect(isFrameworkMessageKind(kind)).toBe(true);
  });

  it("brands framework-authored user-role messages", () => {
    const message = createFrameworkUserMessage(
      "execution.continuation",
      "Continue the interrupted turn.",
    );

    expect(message).toEqual({
      content: "Continue the interrupted turn.",
      kind: "execution.continuation",
      role: "user",
    });
    expect(isFrameworkUserMessage(message)).toBe(true);
    expect(isFrameworkUserMessage({ content: "A user message", role: "user" })).toBe(false);
    expect(isFrameworkMessageKind("synthetic")).toBe(false);
  });

  it("brands real user messages with the user kind", () => {
    const message = createUserMessage("user", "A user message");

    expect(message).toEqual({ content: "A user message", kind: "user", role: "user" });
    expect(isUserMessageKind("user")).toBe(true);
    expect(isUserModelMessage(message)).toBe(true);
    expect(isFrameworkUserMessage(message)).toBe(false);
  });

  it("rejects unclassified user messages before history retention", () => {
    expect(() =>
      validateHarnessModelMessages([{ content: "A user message", role: "user" }]),
    ).toThrow("Expected every user-role model message to have a kind.");
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

  it("returns null when assistant text is only whitespace", () => {
    const messages: ModelMessage[] = [{ content: " \n\t", role: "assistant" }];

    expect(resolveAssistantStepText(messages, undefined)).toBeNull();
  });

  it("returns null when the fallback is only whitespace", () => {
    expect(resolveAssistantStepText([], " \n\t")).toBeNull();
  });
});
