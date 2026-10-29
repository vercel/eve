import { jsonSchema, type ModelMessage } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { createUserMessage } from "#harness/messages.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import { repairToolHistory } from "#harness/tool-history-repair.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import { setTurnClientContextState } from "#harness/turn-client-context.js";
import type { HarnessSession } from "#harness/types.js";
import { foldingHandler, withOpenTurn } from "#internal/testing/session-machine.js";

const call = { type: "tool-call" as const, toolCallId: "old-call", toolName: "work", input: {} };
const calling: ModelMessage = { role: "assistant", content: [call] };
const user = createUserMessage("user", "What happened?");
const result = {
  type: "tool-result" as const,
  toolCallId: call.toolCallId,
  toolName: call.toolName,
  output: { type: "json" as const, value: { saved: true } },
};
const unknownResult = {
  ...result,
  output: { type: "error-text", value: expect.stringContaining("execution outcome is unknown") },
};
function results(messages: readonly ModelMessage[]) {
  return messages.flatMap((message) =>
    message.role === "tool" ? message.content.filter((part) => part.type === "tool-result") : [],
  );
}

describe("saved tool history", () => {
  it.each(["missing result", "partial results", "failed request"])(
    "repairs seeded history across followups: %s",
    async (kind) => {
      const execute = vi.fn(async () => ({ saved: true }));
      const doStream = vi.fn<MockLanguageModelV4["doStream"]>(async () => ({
        stream: convertArrayToReadableStream([
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: "Continuing safely." },
          { type: "text-end", id: "text" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
              outputTokens: { reasoning: 0, text: 1, total: 1 },
            },
          },
        ]),
      }));
      if (kind === "failed request") doStream.mockRejectedValueOnce(new Error("Model unavailable"));
      const sibling = { ...result, toolCallId: "sibling" };
      const partial = kind === "partial results";
      const history: HarnessSession["history"] = partial
        ? [
            { role: "assistant", content: [call, { ...call, toolCallId: sibling.toolCallId }] },
            { role: "tool", content: [sibling] },
            user,
          ]
        : [calling, user];
      const tool = {
        name: "work",
        description: "Save work",
        inputSchema: jsonSchema({ type: "object" }),
        execute,
      };
      const step = createToolLoopHarness({
        handleEvent: foldingHandler(),
        resolveModel: async () => new MockLanguageModelV4({ doStream }),
        tools: new Map([["work", tool]]),
      });
      const run = (session: HarnessSession) => {
        const ctx = new ContextContainer();
        enterSessionProjection(ctx, session.state);
        return contextStorage.run(ctx, () => step(session, { message: "Continue" }));
      };
      const initial = setTurnClientContextState(
        withOpenTurn(
          {
            agent: { modelReference: { id: "repair-test" }, system: "Test assistant", tools: [] },
            compaction: { recentWindowSize: 10, threshold: 100_000 },
            continuationToken: "http:repair-test",
            sessionId: "repair-test",
            history,
          },
          { sequence: 1, turnId: "retry-turn" },
        ),
        {
          turnId: "retry-turn",
          insertionIndex: partial ? 2 : 1,
          messages: ["Client context"],
        },
      );
      const first = await run(initial);
      expect(first.next).toBeNull();
      expect(results(first.session.history)).toEqual(
        partial ? [sibling, unknownResult] : [unknownResult],
      );
      const prompt = doStream.mock.calls[0]![0].prompt;
      const contextIndex = prompt.findIndex(
        (message) =>
          message.role === "user" &&
          message.content.some((part) => part.type === "text" && part.text === "Client context"),
      );
      expect(contextIndex).toBeGreaterThan(0);
      expect(prompt[contextIndex - 1]).toMatchObject({
        role: "tool",
        content: expect.arrayContaining([expect.objectContaining({ toolCallId: call.toolCallId })]),
      });
      expect(prompt[contextIndex + 1]).toMatchObject({
        role: "user",
        content: [{ type: "text", text: "What happened?" }],
      });
      const next = await run(first.session);
      expect(doStream).toHaveBeenCalledTimes(2);
      expect(results(next.session.history)).toEqual(results(first.session.history));
      expect(JSON.stringify(next.session.history)).toContain("Continuing safely.");
      expect(JSON.stringify(next.session.history)).not.toContain("Client context");
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    "provider",
    "inline-result",
    "sdk-approval",
    "duplicate-call",
    "late-result",
    "earlier-result",
  ])("leaves %s history untouched", (kind) => {
    let messages: ModelMessage[] = [calling, user];
    if (kind === "provider")
      messages = [{ role: "assistant", content: [{ ...call, providerExecuted: true }] }, user];
    if (kind === "inline-result") messages = [{ role: "assistant", content: [call, result] }, user];
    if (kind === "sdk-approval") {
      const request = {
        type: "tool-approval-request" as const,
        approvalId: "approval",
        toolCallId: call.toolCallId,
      };
      messages = [{ role: "assistant", content: [call, request] }, user];
    }
    if (kind === "duplicate-call") messages.push(calling);
    if (kind === "late-result") messages.push({ role: "tool", content: [result] });
    if (kind === "earlier-result") messages.unshift({ role: "tool", content: [result] });
    const original = structuredClone(messages);
    expect(repairToolHistory({ messages, insertionIndex: 1 })).toEqual({
      messages: original,
      insertionIndex: 1,
    });
    expect(messages).toEqual(original);
  });
});
