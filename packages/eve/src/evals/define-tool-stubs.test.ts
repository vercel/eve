import { describe, expect, it } from "vitest";

import { defineToolStubs } from "#evals/define-tool-stubs.js";

describe("defineToolStubs", () => {
  it("returns a tagged stub set with its state and tools", () => {
    const state = () => ({ schedules: [] });
    const schedulesRead = () => ({ schedules: [] });

    const stubs = defineToolStubs({ state, tools: { schedules_read: schedulesRead } });

    expect(stubs).toEqual({
      _tag: "EveToolStubs",
      state,
      tools: { schedules_read: schedulesRead },
    });
  });

  it("names the tool whose stub is not a function", () => {
    const tools = { schedules_read: { schedules: [] } };

    expect(() => defineToolStubs({ tools } as never)).toThrow(
      "defineToolStubs() expects tools.schedules_read to be a function that returns the tool result; got object.",
    );
  });

  it("rejects a state that is not a function", () => {
    const state = { schedules: [] };

    expect(() => defineToolStubs({ state, tools: {} } as never)).toThrow(
      "defineToolStubs() expects state to be a function that returns the starting state; got object.",
    );
  });
});
