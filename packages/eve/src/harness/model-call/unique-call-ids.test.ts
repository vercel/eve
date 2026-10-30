import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3, MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";

import { withUniqueCallIds } from "./unique-call-ids.js";

const finish: LanguageModelV4StreamPart = {
  finishReason: { raw: "tool-calls", unified: "tool-calls" },
  type: "finish",
  usage: {
    inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
    outputTokens: { reasoning: 0, text: 1, total: 1 },
  },
};

function modelStreaming(parts: readonly LanguageModelV4StreamPart[]) {
  return new MockLanguageModelV4({
    doStream: async () => ({ stream: convertArrayToReadableStream([...parts, finish]) }),
  });
}

async function streamed(model: ReturnType<typeof withUniqueCallIds>) {
  if (typeof model === "string" || model.specificationVersion !== "v4") throw new Error("v4");
  const { stream } = await model.doStream({ prompt: [] });
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read())
    parts.push(read.value);
  // Each part's call id, in stream order, for the parts that name one.
  return parts.flatMap((part) =>
    "toolCallId" in part
      ? [`${part.type} ${part.toolCallId}`]
      : part.type.startsWith("tool-input")
        ? [`${part.type} ${(part as { id: string }).id}`]
        : [],
  );
}

const call = (toolCallId: string) =>
  ({ input: "{}", toolCallId, toolName: "lookup", type: "tool-call" }) as const;

describe("withUniqueCallIds", () => {
  it("passes ids through when nothing holds them", async () => {
    const model = withUniqueCallIds(modelStreaming([call("call_1"), call("call_2")]), ["call_0"]);
    expect(await streamed(model)).toEqual(["tool-call call_1", "tool-call call_2"]);
  });

  it("renames a call that repeats a taken id, with every part that refers to it", async () => {
    const model = withUniqueCallIds(
      modelStreaming([
        { id: "call_0", toolName: "lookup", type: "tool-input-start" },
        { delta: "{}", id: "call_0", type: "tool-input-delta" },
        { id: "call_0", type: "tool-input-end" },
        call("call_0"),
        { approvalId: "approval_0", toolCallId: "call_0", type: "tool-approval-request" },
      ]),
      ["call_0"],
    );
    expect(await streamed(model)).toEqual([
      "tool-input-start call_0_2",
      "tool-input-delta call_0_2",
      "tool-input-end call_0_2",
      "tool-call call_0_2",
      "tool-approval-request call_0_2",
    ]);
  });

  it("gives two calls of one response that share an id each their own", async () => {
    const model = withUniqueCallIds(modelStreaming([call("call_0"), call("call_0")]), []);
    expect(await streamed(model)).toEqual(["tool-call call_0", "tool-call call_0_2"]);
  });

  it("skips past renamed ids already taken, and keeps a provider's result on its call", async () => {
    const model = withUniqueCallIds(
      modelStreaming([
        call("call_0"),
        {
          result: { found: true },
          toolCallId: "call_0",
          toolName: "lookup",
          type: "tool-result",
        } as LanguageModelV4StreamPart,
      ]),
      ["call_0", "call_0_2"],
    );
    expect(await streamed(model)).toEqual(["tool-call call_0_3", "tool-result call_0_3"]);
  });

  it("wraps a model on an earlier specification, which the AI SDK adapts", async () => {
    const legacy = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([call("call_0"), finish] as never[]),
      }),
    });
    expect(await streamed(withUniqueCallIds(legacy, ["call_0"]))).toEqual(["tool-call call_0_2"]);
  });

  it("resolves a model named by a string as the AI SDK does, and renames its calls", async () => {
    const requested: string[] = [];
    const provider = {
      languageModel: (id: string) => {
        requested.push(id);
        return modelStreaming([call("call_0")]);
      },
    };
    Reflect.set(globalThis, "AI_SDK_DEFAULT_PROVIDER", provider);
    try {
      expect(await streamed(withUniqueCallIds("openai/gpt-5", ["call_0"]))).toEqual([
        "tool-call call_0_2",
      ]);
      expect(requested).toEqual(["openai/gpt-5"]);
    } finally {
      Reflect.deleteProperty(globalThis, "AI_SDK_DEFAULT_PROVIDER");
    }
  });
});
