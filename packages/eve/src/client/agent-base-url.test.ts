import { describe, expect, it } from "vitest";

import { resolveEveAgentBaseUrl } from "#client/agent-base-url.js";

describe("resolveEveAgentBaseUrl", () => {
  it("defaults to same-origin root eve routes", () => {
    expect(resolveEveAgentBaseUrl({})).toBe("");
  });

  it("preserves an explicit base URL", () => {
    expect(resolveEveAgentBaseUrl({ baseUrl: "/api" })).toBe("/api");
  });

  it("maps a named agent to the same-origin named route prefix", () => {
    expect(resolveEveAgentBaseUrl({ agent: "support" })).toBe("/eve/support");
  });

  it("rejects baseUrl and agent together", () => {
    expect(() => resolveEveAgentBaseUrl({ agent: "support", baseUrl: "/api" })).toThrow(
      "cannot combine agent and baseUrl",
    );
  });

  it("rejects names that are not safe route segments", () => {
    expect(() => resolveEveAgentBaseUrl({ agent: "Support" })).toThrow("eve agent name");
  });
});
