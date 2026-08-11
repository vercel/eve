import { describe, expect, it } from "vitest";

import { defineVercelBranchAgent } from "#public/agents/vercel.js";

describe("defineVercelBranchAgent", () => {
  it("returns a standard remote agent using Vercel OIDC", async () => {
    const agent = defineVercelBranchAgent({
      branch: "feature/preview-agent",
      description: "Preview agent.",
      forwardPrincipal: true,
      url: "https://my-agent-git-feature-preview-agent-acme.vercel.app",
    });

    expect(agent).toMatchObject({
      description: "Preview agent.",
      forwardPrincipal: true,
      kind: "remote",
      path: "/eve/v1/session",
      url: "https://my-agent-git-feature-preview-agent-acme.vercel.app",
    });
    expect(agent.auth).toBeTypeOf("function");
  });

  it("requires a branch", () => {
    expect(() =>
      defineVercelBranchAgent({
        branch: "  ",
        description: "Preview agent.",
        url: "https://preview.example.com",
      }),
    ).toThrow("requires a non-empty branch");
  });
});
