import { describe, expect, it } from "vitest";

import {
  collectMcpSessionUpdates,
  mcpSessionStateKey,
  type McpSessionSlot,
} from "#runtime/connections/mcp-session-store.js";

describe("mcpSessionStateKey", () => {
  it("includes connection name and principal", () => {
    expect(mcpSessionStateKey("linear", "user:slack:U123")).toBe(
      "eve.mcp.session.linear.user:slack:U123",
    );
  });

  it('falls back to "anonymous" for no principal', () => {
    expect(mcpSessionStateKey("linear", null)).toBe("eve.mcp.session.linear.anonymous");
    expect(mcpSessionStateKey("linear", undefined)).toBe("eve.mcp.session.linear.anonymous");
  });
});

describe("collectMcpSessionUpdates", () => {
  it("returns captured ids that differ from the seeded id", () => {
    const slots = new Map<string, McpSessionSlot>([
      ["a", { stateKey: "k.a", initialId: undefined, sessionId: "s-a" }],
      ["b", { stateKey: "k.b", initialId: "s-b", sessionId: "s-b" }], // unchanged
      ["c", { stateKey: "k.c", initialId: "old", sessionId: "new" }], // re-init
      ["d", { stateKey: "k.d", initialId: undefined, sessionId: undefined }], // never set
    ]);
    expect(collectMcpSessionUpdates(slots)).toEqual([
      { stateKey: "k.a", sessionId: "s-a" },
      { stateKey: "k.c", sessionId: "new" },
    ]);
  });
});
