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
    vi.restoreAllMocks();
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

  it.each([
    [
      "remote",
      {
        kind: "remote",
        serverUrl: "https://remote.example.com/",
        workspaceRoot: "/tmp/app",
      },
    ],
    [
      "local",
      {
        kind: "local",
        serverUrl: "http://127.0.0.1:4321/",
        workspaceRoot: "/tmp/app",
      },
    ],
  ] satisfies Array<readonly [string, DevelopmentTuiTarget]>)(
    "passes explicit headers to %s TUI client requests",
    async (_name, target) => {
      await runDevelopmentTui({
        headers: {
          authorization: "Basic dGVzdDpzZWNyZXQ=",
          "x-tenant": "acme",
        },
        target,
      });

      const client = mocks.runnerOptions[0]?.client;
      if (client === undefined) {
        throw new Error("Expected a TUI client.");
      }

      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
      await client.fetch("/eve/v1/info");

      const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
      expect(headers.get("authorization")).toBe("Basic dGVzdDpzZWNyZXQ=");
      expect(headers.get("x-tenant")).toBe("acme");
    },
  );
});
