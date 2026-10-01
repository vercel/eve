import { describe, expect, it } from "vitest";

import { defineToolStubs, isToolStubs, type ToolStubsInput } from "#evals/tool-stubs.js";

/** Builds input that the types forbid, as JavaScript authors can still write it. */
function untypedInput(input: object): ToolStubsInput<unknown> {
  return input as ToolStubsInput<unknown>;
}

describe("defineToolStubs", () => {
  it("brands the set so the eval server can recognize it", () => {
    const stubs = defineToolStubs({
      state: () => ({ drafts: [] as string[] }),
      tools: { list_drafts: (_input, { state }) => ({ drafts: state.drafts }) },
    });

    expect(isToolStubs(stubs)).toBe(true);
    expect(isToolStubs({ tools: {} })).toBe(false);
  });

  it("rejects a stub that is not a function", () => {
    expect(() => defineToolStubs(untypedInput({ tools: { list_drafts: "drafts" } }))).toThrow(
      'Tool stub "list_drafts" must be a function.',
    );
  });

  it("rejects a state that is not a function", () => {
    expect(() => defineToolStubs(untypedInput({ state: { drafts: [] }, tools: {} }))).toThrow(
      "Tool stubs `state` must be a function",
    );
  });

  it("rejects tools that are not an object", () => {
    expect(() => defineToolStubs(untypedInput({ tools: [] }))).toThrow(
      "Tool stubs `tools` must be an object",
    );
  });
});
