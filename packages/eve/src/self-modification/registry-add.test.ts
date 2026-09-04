import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalDevCapability } from "#public/local-dev.js";

const { findPackageJSON, readFile } = vi.hoisted(() => ({
  findPackageJSON: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("node:module", () => ({ findPackageJSON }));
vi.mock("node:fs/promises", () => ({ readFile }));

import { readTerminalHeadlessEvent, runEveAdd } from "./extension/eve-add.js";
import { addRegistryItem, handoffMessage, unsetEnvVars } from "./extension/tools/registry_add.js";
import { clearRegistryIndexCache } from "./extension/tools/search_registry.js";

const APP_ROOT = "/workspace/agent";

const INDEX = {
  items: [
    {
      name: "extension/browserbase",
      title: "Browserbase",
      envVars: { BROWSERBASE_API_KEY: "", BROWSERBASE_PROJECT_ID: "" },
      files: [{ target: "agent/extensions/browserbase.ts" }],
    },
    {
      name: "channel/slack",
      title: "Slack",
      meta: {
        eve: { setup: { package: "eve", bin: "eve", args: ["integration", "setup", "slack"] } },
      },
    },
    {
      name: "linear",
      title: "Linear",
      meta: {
        eve: { components: [{ item: "channel/linear-agent" }, { item: "connection/linear" }] },
      },
    },
    {
      name: "@acme/widget",
      title: "Acme Widget",
    },
  ],
};

function capability(overrides: Partial<LocalDevCapability> = {}): LocalDevCapability {
  return {
    appRoot: APP_ROOT,
    interactiveClient: false,
    withSuspendedSource: async (task) => await task(),
    ...overrides,
  };
}

/** A child process that emits the given output and exit code. */
function fakeSpawn(input: { code: number; output: string }) {
  const calls: { command: string; args: readonly string[]; options: unknown }[] = [];
  const spawn = vi.fn((command: string, args: readonly string[], options: unknown) => {
    calls.push({ args, command, options });
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      kill: () => void;
    };
    child.stdout = Readable.from([input.output]);
    child.stderr = Readable.from([]);
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.on("end", () => child.emit("close", input.code));
      child.stdout.resume();
    });
    return child;
  });
  return { calls, spawn: spawn as never };
}

function controlledSpawn() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = Readable.from([]);
  child.stderr = Readable.from([]);
  child.kill = vi.fn();
  return { child, spawn: vi.fn(() => child) as never };
}

const COMPLETED = JSON.stringify({
  version: 1,
  type: "completed",
  item: "extension/browserbase",
  completedItems: ["extension/browserbase"],
});

beforeEach(() => {
  clearRegistryIndexCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(INDEX), { status: 200 })),
  );
  // The eve bin is resolved from the app's own dependency graph, never PATH.
  findPackageJSON.mockReturnValue(`${APP_ROOT}/node_modules/eve/package.json`);
  readFile.mockResolvedValue(JSON.stringify({ name: "eve", bin: { eve: "./bin/eve.js" } }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("addRegistryItem", () => {
  it("refuses to run without the development capability", async () => {
    await expect(
      addRegistryItem("extension/browserbase", { getCapability: () => undefined }),
    ).rejects.toThrow(/only be installed while `eve dev` is running/u);
  });

  it("hands a setup-bearing item over without installing anything", async () => {
    const { calls, spawn } = fakeSpawn({ code: 0, output: COMPLETED });
    const result = await addRegistryItem("channel/slack", {
      getCapability: () => capability(),
      spawn,
    });

    expect(result.status).toBe("needs-terminal");
    expect(result.title).toBe("Slack");
    expect(result.nextCommand).toBe("eve add channel/slack");
    expect(calls).toHaveLength(0);
  });

  it("hands a bundle over without installing anything", async () => {
    const { calls, spawn } = fakeSpawn({ code: 0, output: COMPLETED });
    const result = await addRegistryItem("linear", { getCapability: () => capability(), spawn });

    expect(result.status).toBe("needs-terminal");
    expect(result.reason).toContain("channel/linear-agent");
    expect(calls).toHaveLength(0);
  });

  it("leaves the automatically queued setup to an interactive client", async () => {
    const result = await addRegistryItem("channel/slack", {
      getCapability: () => capability({ interactiveClient: true }),
    });

    expect(result.nextCommand).toBeUndefined();
    expect(result.message).toContain("setup panel");
    expect(result.message).toContain("do not ask the developer to run another command");
  });

  it("installs an exact item from a configured registry without restricting its address", async () => {
    const address = "@acme/widget";
    const { calls, spawn } = fakeSpawn({
      code: 0,
      output: JSON.stringify({ version: 1, type: "completed", item: address }),
    });
    const result = await addRegistryItem(address, {
      getCapability: () => capability(),
      spawn,
    });

    expect(result.status).toBe("installed");
    expect(calls[0]?.args).toContain(address);
  });

  it("rejects an address the registry does not publish", async () => {
    await expect(
      addRegistryItem("channel/nonexistent", { getCapability: () => capability() }),
    ).rejects.toThrow(/No item in the configured eve registry is published/u);
  });

  it("installs a no-setup item with a fixed argv and reports unset envVars", async () => {
    const { calls, spawn } = fakeSpawn({
      code: 0,
      output: `Something from shadcn\n${COMPLETED}\n`,
    });
    const suspended: string[] = [];
    const result = await addRegistryItem("extension/browserbase", {
      getCapability: () =>
        capability({
          withSuspendedSource: async (task) => {
            suspended.push("suspend");
            try {
              return await task();
            } finally {
              suspended.push("resume");
            }
          },
        }),
      spawn,
    });

    expect(result.status).toBe("installed");
    expect(result.envVars).toEqual(["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"]);
    expect(result.message).toContain("BROWSERBASE_API_KEY");
    expect(suspended).toEqual(["suspend", "resume"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.slice(1)).toEqual([
      "add",
      "extension/browserbase",
      "--non-interactive",
      "--skip-setup",
    ]);
    expect(calls[0]?.options).toMatchObject({ cwd: APP_ROOT });
  });

  it("does not relay child output when the child does not report completion", async () => {
    const { spawn } = fakeSpawn({ code: 1, output: "secret-child-output\n" });
    const install = addRegistryItem("extension/browserbase", {
      getCapability: () => capability(),
      spawn,
    });

    await expect(install).resolves.toMatchObject({
      status: "failed",
      message: expect.stringMatching(/may have partially changed the project/u),
    });
    await expect(install).resolves.not.toMatchObject({
      message: expect.stringContaining("secret-child-output"),
    });
  });

  it("returns a sanitized structured failure and its partial changes", async () => {
    const { spawn } = fakeSpawn({
      code: 1,
      output: [
        "token=secret-child-output",
        JSON.stringify({
          version: 1,
          type: "failed",
          item: "extension/browserbase",
          completedItems: [],
          message: "untrusted child message",
          failureCode: "pnpm_build_policy",
          changed: ["package.json"],
        }),
      ].join("\n"),
    });

    await expect(
      addRegistryItem("extension/browserbase", { getCapability: () => capability(), spawn }),
    ).resolves.toMatchObject({
      status: "failed",
      changed: ["package.json"],
      message: expect.stringContaining("pnpm requires build-script decisions"),
    });
  });

  it("waits for a cancelled child to close before releasing the install", async () => {
    const { child, spawn } = controlledSpawn();
    const controller = new AbortController();
    const install = runEveAdd({
      address: "extension/browserbase",
      appRoot: APP_ROOT,
      signal: controller.signal,
      spawn,
    });
    controller.abort();

    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"));
    let settled = false;
    void install.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit("close", null);
    await expect(install).resolves.toEqual({
      kind: "failed",
      message: "Installing extension/browserbase was cancelled.",
    });
  });

  it("hands over an install the child reports as blocked", async () => {
    const { spawn } = fakeSpawn({
      code: 2,
      output: JSON.stringify({
        version: 1,
        type: "blocked",
        item: "extension/browserbase",
        message: "Setup needs an answer.",
      }),
    });
    const result = await addRegistryItem("extension/browserbase", {
      getCapability: () => capability(),
      spawn,
    });

    expect(result.status).toBe("needs-terminal");
    expect(result.reason).toBe(
      "Installing extension/browserbase stopped for input that only a terminal can supply.",
    );
    expect(result.reason).not.toContain("Setup needs an answer.");
  });
});

describe("unsetEnvVars", () => {
  const entry = {
    address: "extension/browserbase",
    envVars: ["A", "B"],
    title: "Browserbase",
  } as const;

  it("names only the variables that are not set", () => {
    expect(unsetEnvVars(entry, { A: "value" })).toEqual(["B"]);
    expect(unsetEnvVars(entry, { A: "value", B: "value" })).toEqual([]);
  });

  it("treats an empty value as unset", () => {
    expect(unsetEnvVars(entry, { A: "", B: "value" })).toEqual(["A"]);
  });

  it("treats a missing envVars field as declaring none", () => {
    expect(unsetEnvVars({ address: "linear", title: "Linear" }, {})).toEqual([]);
  });
});

describe("handoffMessage", () => {
  it("names the shell command with no interactive client", () => {
    expect(
      handoffMessage({
        address: "channel/slack",
        interactiveClient: false,
        reason: "It declares a setup flow.",
        title: "Slack",
      }),
    ).toEqual({
      message: expect.stringContaining("`eve add channel/slack`"),
      nextCommand: "eve add channel/slack",
    });
  });

  it("directs an interactive client to the automatically opened setup panel", () => {
    expect(
      handoffMessage({
        address: "channel/slack",
        interactiveClient: true,
        reason: "It declares a setup flow.",
        title: "Slack",
      }),
    ).toEqual({
      message: expect.stringContaining("setup panel"),
    });
  });
});

describe("readTerminalHeadlessEvent", () => {
  it("finds the terminal event among the registry SDK's own output", () => {
    expect(
      readTerminalHeadlessEvent(
        [
          "Checking registry.",
          `{"version":1,"type":"progress","message":"Installed x"}`,
          COMPLETED,
          "+ KEY",
        ].join("\n"),
      ),
    ).toMatchObject({ type: "completed" });
  });

  it("ignores lines that are not JSON", () => {
    expect(readTerminalHeadlessEvent("not json\n{broken\n")).toBeUndefined();
  });

  it("keeps the last terminal event", () => {
    expect(
      readTerminalHeadlessEvent(
        [
          `{"version":1,"type":"cancelled","item":"a"}`,
          `{"version":1,"type":"failed","item":"a","message":"boom"}`,
        ].join("\n"),
      ),
    ).toMatchObject({ type: "failed", message: "boom" });
  });
});
