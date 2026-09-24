import { describe, expect, it } from "vitest";

import { normalizeSubagentConfig } from "#compiler/normalize-subagent.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineRemoteAgent } from "#public/definitions/remote-agent.js";

describe("normalizeSubagentConfig", () => {
  it("normalizes a local agent definition as a subagent", () => {
    const normalized = normalizeSubagentConfig(
      defineAgent({
        description: "Research deeply.",
        model: "openai/gpt-5.5",
      }),
      "Invalid subagent.",
    );

    expect(normalized).toEqual({
      definition: {
        description: "Research deeply.",
        model: "openai/gpt-5.5",
      },
      kind: "local",
    });
  });

  it("preserves a local subagent's tool setting", () => {
    expect(
      normalizeSubagentConfig(
        defineAgent({
          description: "Research deeply.",
          model: "openai/gpt-5.5",
          tool: false,
        }),
        "Invalid subagent.",
      ),
    ).toMatchObject({ definition: { tool: false }, kind: "local" });
  });

  it("normalizes a remote subagent", () => {
    expect(
      normalizeSubagentConfig(
        defineRemoteAgent({
          description: "Review remotely.",
          url: "https://review.example.com",
        }),
        "Invalid subagent.",
      ),
    ).toMatchObject({ kind: "remote" });
  });

  it("rejects a non-boolean remote subagent tool setting", () => {
    expect(() =>
      normalizeSubagentConfig(
        {
          description: "Review remotely.",
          kind: "remote",
          tool: "no",
          url: "https://review.example.com",
        },
        "Invalid subagent.",
      ),
    ).toThrow("Invalid subagent.");
  });

  it("validates a remote subagent's timeout", () => {
    const remote = (timeout: unknown) =>
      normalizeSubagentConfig(
        {
          ...defineRemoteAgent({ description: "Drafts content.", url: "https://content.example" }),
          timeout,
        },
        "Invalid subagent.",
      );

    expect(() => remote(3 * 60 * 60_000)).not.toThrow();
    expect(() => remote(false)).not.toThrow();
    expect(() => remote(0)).toThrow(
      'Invalid subagent. "timeout" must be a positive number of milliseconds or false, received 0.',
    );
  });

  it("preserves a remote subagent's tool setting", () => {
    expect(
      normalizeSubagentConfig(
        defineRemoteAgent({
          description: "Review remotely.",
          tool: false,
          url: "https://review.example.com",
        }),
        "Invalid subagent.",
      ),
    ).toMatchObject({ kind: "remote", tool: false });
  });
});
