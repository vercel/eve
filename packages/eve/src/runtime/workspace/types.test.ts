import { describe, expect, it } from "vitest";

import { agentHomeSlug, resolveAgentHome, WORKSPACE_ROOT } from "#runtime/workspace/types.js";

describe("agentHomeSlug", () => {
  it("derives a readable slug with a stable hash suffix", () => {
    expect(agentHomeSlug("subagents/researcher")).toMatch(/^researcher-[0-9a-f]{8}$/);
  });

  it("keeps slugs distinct for same-leaf nodes under different parents", () => {
    expect(agentHomeSlug("a/worker")).not.toBe(agentHomeSlug("b/worker"));
  });

  it("sanitizes shell-hostile characters out of the leaf", () => {
    expect(agentHomeSlug("parent/Agent Worker!")).toMatch(/^agent-worker--[0-9a-f]{8}$/);
  });
});

describe("resolveAgentHome", () => {
  it("places every agent home under /agents", () => {
    expect(resolveAgentHome("subagents/researcher")).toMatch(/^\/agents\/researcher-[0-9a-f]{8}$/);
  });

  it("keeps the shared workspace root outside agent homes", () => {
    expect(WORKSPACE_ROOT).toBe("/workspace");
  });
});
