import { describe, expect, it } from "vitest";

import { restoreSessionHistory } from "#harness/history-restoration.js";
import type { HarnessSession } from "#harness/types.js";

function session(): HarnessSession {
  return {
    agent: { modelReference: { id: "model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 1000 },
    continuationToken: "test",
    history: [
      { content: "first", role: "user" },
      { content: "second", role: "assistant" },
    ],
    sessionId: "session",
  };
}

describe("history restoration", () => {
  it("retains the exact prefix before the requested index", () => {
    expect(restoreSessionHistory(session(), 1).history).toEqual([
      { content: "first", role: "user" },
    ]);
  });

  it.each([-1, 1.5, 3, Number.NaN])("rejects invalid index %s", (index) => {
    expect(() => restoreSessionHistory(session(), index)).toThrow(
      "History restoration index must be an integer from 0 through 2",
    );
  });
});
