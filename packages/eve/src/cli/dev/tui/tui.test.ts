import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EveTUIRunnerOptions } from "./runner.js";

const mocks = vi.hoisted<{ runnerOptions: EveTUIRunnerOptions[] }>(() => ({
  runnerOptions: [],
}));

vi.mock("./runner.js", () => ({
  EveTUIRunner: class {
    constructor(options: EveTUIRunnerOptions) {
      mocks.runnerOptions.push(options);
    }

    async run(): Promise<void> {}
  },
}));

import { runDevelopmentTui, type DevelopmentTuiTarget } from "./tui.js";

describe("runDevelopmentTui", () => {
  beforeEach(() => {
    mocks.runnerOptions.length = 0;
  });

  it("creates a fresh client session for every TUI attached to the same server", async () => {
    const target = {
      kind: "local",
      serverUrl: "http://127.0.0.1:4321/",
      workspaceRoot: "/tmp/app",
    } satisfies DevelopmentTuiTarget;
    await runDevelopmentTui({ target });
    await runDevelopmentTui({ target });

    expect(mocks.runnerOptions).toHaveLength(2);
    const [first, second] = mocks.runnerOptions;
    if (first === undefined || second === undefined) {
      throw new Error("Expected two TUI runner invocations.");
    }
    expect(first.client).not.toBe(second.client);
    expect(first.session).not.toBe(second.session);
  });
});
