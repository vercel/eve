import { describe, expect, it } from "vitest";

import type { StoredHistoryMessage } from "#shared/history-message.js";

import { turns } from "./strategies.js";

describe("turns", () => {
  it("does not wait for a result after a provider-run tool call", () => {
    const history: StoredHistoryMessage[] = [
      { content: "Search for it.", kind: "user", role: "user" },
      {
        content: [
          {
            input: {},
            providerExecuted: true,
            toolCallId: "call-1",
            toolName: "web_search",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      { content: "Thanks.", kind: "user", role: "user" },
    ];

    expect(turns(history)).toHaveLength(2);
  });

  it("keeps a call that ran here together with its result", () => {
    const history: StoredHistoryMessage[] = [
      { content: "Read it.", kind: "user", role: "user" },
      {
        content: [{ input: {}, toolCallId: "call-1", toolName: "read", type: "tool-call" }],
        role: "assistant",
      },
      {
        content: [
          {
            output: { type: "text", value: "ok" },
            toolCallId: "call-1",
            toolName: "read",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
      { content: "Thanks.", kind: "user", role: "user" },
    ];

    expect(turns(history).map((group) => group.length)).toEqual([3, 1]);
  });
});
