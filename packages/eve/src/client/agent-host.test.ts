import { describe, expect, it } from "vitest";

import { resolveEveAgentHost } from "#client/agent-host.js";

describe("resolveEveAgentHost", () => {
  it("defaults to same-origin root eve routes", () => {
    expect(resolveEveAgentHost({})).toBe("");
  });

  it("preserves explicit hosts", () => {
    expect(resolveEveAgentHost({ host: "/api" })).toBe("/api");
  });

  it("maps a named agent to the same-origin named route prefix", () => {
    expect(resolveEveAgentHost({ agent: "support" })).toBe("/eve/agents/support");
  });

  it("rejects host and agent together", () => {
    expect(() => resolveEveAgentHost({ agent: "support", host: "/api" })).toThrow(
      "cannot combine agent and host",
    );
  });

  it("rejects names that are not safe route segments", () => {
    expect(() => resolveEveAgentHost({ agent: "Support" })).toThrow("eve agent name");
  });
});
