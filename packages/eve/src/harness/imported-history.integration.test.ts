import { MockLanguageModelV3 } from "ai/test";
import { expect, it } from "vitest";

import { createTestKernel } from "#internal/testing/kernel.js";
import type { HarnessSession, HarnessStepInput } from "#harness/types.js";
import { eachEvent, withPublished } from "#internal/testing/session-machine.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { ImportedMessage } from "#protocol/session-events/families/delivery.js";

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
  outputTokens: { reasoning: 0, text: 2, total: 2 },
};

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const reply: StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { id: "t", type: "text-start" },
  { delta: "ok", id: "t", type: "text-delta" },
  { id: "t", type: "text-end" },
  { finishReason: { raw: undefined, unified: "stop" }, type: "finish", usage },
];

const model = () =>
  new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          for (const part of reply) controller.enqueue(part);
          controller.close();
        },
      }),
    }),
  });

function delivered(
  session: HarnessSession,
  deliveryId: string,
  input: { readonly message: string; readonly history: readonly ImportedMessage[] },
  extra: Omit<HarnessStepInput, "message" | "history" | "deliveries"> = {},
): [HarnessSession, HarnessStepInput] {
  return [
    withPublished(session, [{ data: { deliveryId }, type: "delivery.admitted" }]),
    {
      ...extra,
      deliveries: [
        { deliveryId, history: input.history, parts: [{ kind: "text", text: input.message }] },
      ],
      history: input.history,
      message: input.message,
    },
  ];
}

const prompted = (call: MockLanguageModelV3["doStreamCalls"][number] | undefined) =>
  (call?.prompt ?? []).flatMap((message) =>
    message.role === "system"
      ? []
      : [
          `${message.role}: ${message.content
            .map((part) => ("text" in part ? part.text : part.type))
            .join("")}`,
        ],
  );

it("reads imported history before each turn's context and message, and records it consumed", async () => {
  const llm = model();
  const events: SessionEvent[] = [];
  const harness = createTestKernel({
    agent: { model: { id: "m" } },
    handleEvent: eachEvent(async (event) => {
      events.push(event);
    }),
    resolveModel: async () => llm,
    tools: new Map(),
  });
  const session: HarnessSession = {
    compaction: {},
    continuationToken: "http:history",
    history: [],
    sessionId: "history",
  };
  const earlier: readonly ImportedMessage[] = [
    { id: "m1", role: "user", text: "What is the code word?" },
    { role: "assistant", text: "It is heron." },
  ];
  const first = await harness(
    ...delivered(
      session,
      "d_0",
      { history: earlier, message: "Repeat it." },
      { context: ["Current context"] },
    ),
  );
  const later: readonly ImportedMessage[] = [{ role: "user", text: "Bob: it changed to egret." }];
  await harness(...delivered(first.session, "d_1", { history: later, message: "And now?" }));

  expect(prompted(llm.doStreamCalls[0])).toEqual([
    "user: What is the code word?",
    "assistant: It is heron.",
    "user: Current context",
    "user: Repeat it.",
  ]);
  expect(prompted(llm.doStreamCalls[1]).slice(-3)).toEqual([
    "assistant: ok",
    "user: Bob: it changed to egret.",
    "user: And now?",
  ]);
  expect(
    events.flatMap((event) =>
      event.type === "delivery.consumed"
        ? [[event.data.deliveryId, event.data.turnId, event.data.history]]
        : [],
    ),
  ).toEqual([
    ["d_0", "turn_0", earlier],
    ["d_1", "turn_1", later],
  ]);
});

it("imports finished tool calls as model history without running them", async () => {
  const llm = model();
  const events: SessionEvent[] = [];
  const harness = createTestKernel({
    agent: { model: { id: "m" } },
    handleEvent: eachEvent(async (event) => {
      events.push(event);
    }),
    resolveModel: async () => llm,
    tools: new Map(),
  });
  const session: HarnessSession = {
    compaction: {},
    continuationToken: "http:history-tools",
    history: [],
    sessionId: "history-tools",
  };
  const earlier: readonly ImportedMessage[] = [
    { role: "user", text: "Roll a d20 but keep the number to yourself." },
    {
      parts: [
        {
          callId: "c1",
          input: { sides: 20 },
          name: "roll_dice",
          output: { rolls: [3] },
          type: "tool",
        },
        { callId: "c2", error: "Out of dice.", name: "roll_dice", type: "tool" },
        { text: "Done, it's a secret.", type: "text" },
      ],
      role: "assistant",
      text: "Done, it's a secret.",
    },
  ];
  await harness(...delivered(session, "d_0", { history: earlier, message: "What was it?" }));

  const prompt = llm.doStreamCalls[0]?.prompt.filter((message) => message.role !== "system");
  expect(prompt).toEqual([
    expect.objectContaining({ role: "user" }),
    {
      content: [
        expect.objectContaining({
          input: { sides: 20 },
          toolCallId: "c1",
          toolName: "roll_dice",
          type: "tool-call",
        }),
        expect.objectContaining({ toolCallId: "c2", toolName: "roll_dice", type: "tool-call" }),
      ],
      role: "assistant",
    },
    {
      content: [
        expect.objectContaining({
          output: { type: "json", value: { rolls: [3] } },
          toolCallId: "c1",
          type: "tool-result",
        }),
        expect.objectContaining({
          output: { type: "error-text", value: "Out of dice." },
          toolCallId: "c2",
          type: "tool-result",
        }),
      ],
      role: "tool",
    },
    {
      content: [expect.objectContaining({ text: "Done, it's a secret.", type: "text" })],
      role: "assistant",
    },
    expect.objectContaining({ role: "user" }),
  ]);
  expect(events.some((event) => event.type === "call.requested")).toBe(false);
  expect(
    events.flatMap((event) => (event.type === "delivery.consumed" ? [event.data.history] : [])),
  ).toEqual([earlier]);
});
