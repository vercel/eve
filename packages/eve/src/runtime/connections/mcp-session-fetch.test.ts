import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSessionCapturingFetch,
  MCP_SESSION_ID_HEADER,
} from "#runtime/connections/mcp-session-fetch.js";
import type { McpSessionSlot } from "#runtime/connections/mcp-session-store.js";

function slot(overrides: Partial<McpSessionSlot> = {}): McpSessionSlot {
  return { stateKey: "k", ...overrides };
}

afterEach(() => vi.restoreAllMocks());

describe("createSessionCapturingFetch", () => {
  it("injects the session id header when the slot has one", async () => {
    const inner = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const s = slot({ sessionId: "sess-1" });

    await createSessionCapturingFetch(s)("https://mcp.example.com", { method: "POST" });

    const init = inner.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get(MCP_SESSION_ID_HEADER)).toBe("sess-1");
  });

  it("does not inject when the slot has no session id", async () => {
    const inner = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    await createSessionCapturingFetch(slot())("https://mcp.example.com", {});

    const init = inner.mock.calls[0]![1]!;
    expect(new Headers(init.headers).has(MCP_SESSION_ID_HEADER)).toBe(false);
  });

  it("captures the server-assigned session id from the response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200, headers: { [MCP_SESSION_ID_HEADER]: "sess-server" } }),
    );
    const s = slot();

    await createSessionCapturingFetch(s)("https://mcp.example.com", {});

    expect(s.sessionId).toBe("sess-server");
  });

  it("does not clobber a session id already present on the request", async () => {
    const inner = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const s = slot({ sessionId: "slot-id" });

    await createSessionCapturingFetch(s)("https://mcp.example.com", {
      headers: { [MCP_SESSION_ID_HEADER]: "explicit-id" },
    });

    const init = inner.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get(MCP_SESSION_ID_HEADER)).toBe("explicit-id");
  });
});
