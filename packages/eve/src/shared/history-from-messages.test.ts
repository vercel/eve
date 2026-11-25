import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { historyFromMessages } from "#shared/history-from-messages.js";
import { validateSessionHistory } from "#shared/session-history.js";

const call = (toolCallId: string, toolName = "lookup") =>
  ({ input: {}, toolCallId, toolName, type: "tool-call" }) as const;
const result = (toolCallId: string, output: unknown, toolName = "lookup"): ModelMessage =>
  ({
    content: [{ output, toolCallId, toolName, type: "tool-result" }],
    role: "tool",
  }) as ModelMessage;

describe("historyFromMessages", () => {
  it("keeps a turn of many steps valid history, even when a provider repeats call ids", () => {
    const steps: ModelMessage[] = Array.from({ length: 150 }, () => [
      { content: [call("call_0")], role: "assistant" } as ModelMessage,
      result("call_0", { type: "json", value: { ok: true } }),
    ]).flat();
    const history = historyFromMessages([{ content: "Check everything.", role: "user" }, ...steps]);
    const parts = history[1]?.parts ?? [];

    expect(parts).toHaveLength(150);
    expect(parts.filter((part) => part.type === "tool" && part.callId === "call_0")).toHaveLength(
      1,
    );
    expect(parts.every((part) => part.type === "tool" && part.output !== undefined)).toBe(true);
    expect(() => validateSessionHistory(history)).not.toThrow();
  });

  it("records a denied call as failed and a file result as a note", () => {
    const history = historyFromMessages([
      { content: [call("c1", "delete_branch"), call("c2", "screenshot")], role: "assistant" },
      {
        content: [
          {
            output: { reason: "Bob said no.", type: "execution-denied" },
            toolCallId: "c1",
            toolName: "delete_branch",
            type: "tool-result",
          },
          {
            output: {
              type: "content",
              value: [
                { text: "The page:", type: "text" },
                {
                  data: { data: "iVBORw0KGgo=", type: "data" },
                  mediaType: "image/png",
                  type: "file",
                },
              ],
            },
            toolCallId: "c2",
            toolName: "screenshot",
            type: "tool-result",
          },
        ],
        role: "tool",
      } as ModelMessage,
    ]);

    expect(history[0]?.parts).toEqual([
      expect.objectContaining({
        error: "The call was denied: Bob said no.",
        name: "delete_branch",
      }),
      expect.objectContaining({
        name: "screenshot",
        output: "The page:\n[image/png result not copied]",
      }),
    ]);
  });
});
