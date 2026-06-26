import { describe, expect, it, vi } from "vitest";

import { resolveDevUiMode, resolveTuiDisplayOptions, runCli } from "#cli/run.js";
import type { RunDevelopmentTuiInput } from "#cli/dev/tui/tui.js";
import type { DevelopmentServerOptions } from "#internal/nitro/host/types.js";

async function withInteractiveTerminal<T>(fn: () => Promise<T>): Promise<T> {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  try {
    return await fn();
  } finally {
    if (stdinDescriptor !== undefined) {
      Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
    if (stdoutDescriptor !== undefined) {
      Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
  }
}

describe("CLI command registration", () => {
  it("lists the current project creation and Vercel commands", async () => {
    const output: string[] = [];

    await runCli(["--help"], {
      error: (message) => output.push(message),
      log: (message) => output.push(message),
    });

    const help = output.join("\n");
    expect(help).toContain("init [options] [target]");
    expect(help).toContain("link");
    expect(help).toContain("deploy");
    expect(help).not.toContain("setup");
  });
});

describe("eve init compatibility flags", () => {
  it("lists --yes as an accepted compatibility flag", async () => {
    const output: string[] = [];

    await runCli(["init", "--help"], {
      error: (message) => output.push(message),
      log: (message) => output.push(message),
    });

    expect(output.join("\n")).toContain("-y, --yes");
  });

  it("still rejects unknown init options", async () => {
    await expect(
      runCli(["init", "my-agent", "--template"], { error: () => {}, log: () => {} }),
    ).rejects.toThrow();
  });
});

describe("eve CLI malformed argument handling", () => {
  it("prints the setup guide for a coding agent when init has too many targets", async () => {
    const output: string[] = [];

    await expect(
      runCli(
        ["init", "first", "second"],
        { error: (message) => output.push(message), log: (message) => output.push(message) },
        { isCodingAgentLaunch: async () => true },
      ),
    ).rejects.toThrow();

    expect(output.join("\n")).toContain("Set up an eve agent");
  });

  it("still surfaces the usage error for commands other than init", async () => {
    await expect(
      runCli(["dev", "--unknown-flag"], { error: () => {}, log: () => {} }),
    ).rejects.toThrow();
  });
});

describe("eve dev --input", () => {
  it("forwards the initial draft to the interactive TUI", async () => {
    const runDevelopmentTui = vi.fn(async () => {});

    await withInteractiveTerminal(() =>
      runCli(
        ["dev", "--url", "https://example.com", "--input", "/model"],
        { error: () => {}, log: () => {} },
        { runDevelopmentTui },
      ),
    );

    expect(runDevelopmentTui).toHaveBeenCalledWith(
      expect.objectContaining({
        initialInput: "/model",
        target: {
          kind: "remote",
          serverUrl: "https://example.com/",
          workspaceRoot: process.cwd(),
        },
      }),
    );
  });

  it("rejects the option when the terminal cannot run the interactive UI", async () => {
    await expect(
      runCli(
        ["dev", "--url", "https://example.com", "--input", "/model"],
        { error: () => {}, log: () => {} },
        { runDevelopmentTui: vi.fn(async () => {}) },
      ),
    ).rejects.toThrow("--input requires the interactive UI");
  });

  it("rejects the option with explicit --no-ui", async () => {
    await expect(
      runCli(["dev", "--input", "/model", "--no-ui"], {
        error: () => {},
        log: () => {},
      }),
    ).rejects.toThrow("--input requires the interactive UI");
  });
});

describe("eve dev --url protocol", () => {
  it("rejects an http:// remote URL up front instead of crashing during connect", async () => {
    await expect(
      runCli(["dev", "--url", "http://my-app.vercel.app"], { error: () => {}, log: () => {} }),
    ).rejects.toThrow(/https/);
  });
});

describe("eve eval --url protocol", () => {
  it("rejects an http:// remote URL up front", async () => {
    await expect(
      runCli(["eval", "--url", "http://my-app.vercel.app"], { error: () => {}, log: () => {} }),
    ).rejects.toThrow(/https/);
  });
});

describe("eve dev --logs", () => {
  it("accepts sandbox as the initial TUI log mode", async () => {
    const runDevelopmentTui = vi.fn(async () => {});

    await withInteractiveTerminal(() =>
      runCli(
        ["dev", "--url", "https://example.com", "--logs", "sandbox"],
        { error: () => {}, log: () => {} },
        { runDevelopmentTui },
      ),
    );

    expect(runDevelopmentTui).toHaveBeenCalledWith(
      expect.objectContaining({
        logs: "sandbox",
        target: {
          kind: "remote",
          serverUrl: "https://example.com/",
          workspaceRoot: process.cwd(),
        },
      }),
    );
  });
});

describe("eve dev boot progress", () => {
  it("passes one reporter through local startup and clears the row on failure", async () => {
    const writes: string[] = [];
    const close = vi.fn(async () => {});
    let hostReporter: DevelopmentServerOptions["onBootProgress"] = undefined;
    let tuiReporter: RunDevelopmentTuiInput["onBootProgress"] = undefined;
    const startHost = vi.fn((_appRoot: string, options?: DevelopmentServerOptions) => ({
      start: async () => {
        hostReporter = options?.onBootProgress;
        hostReporter?.({ phase: "compiling agent", type: "phase-started" });
        hostReporter?.({ elapsedMs: 1, phase: "compiling agent", type: "phase-finished" });
        return {
          kind: "started" as const,
          appRoot: "/canonical/app",
          url: "http://127.0.0.1:2000",
        };
      },
      close,
    }));
    const runDevelopmentTui = vi.fn(async (input: RunDevelopmentTuiInput) => {
      tuiReporter = input.onBootProgress;
      throw new Error("TUI startup failed");
    });
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      await expect(
        withInteractiveTerminal(() =>
          runCli(["dev"], { error: () => {}, log: () => {} }, { runDevelopmentTui, startHost }),
        ),
      ).rejects.toThrow("TUI startup failed");
    } finally {
      stdoutWrite.mockRestore();
    }

    expect(hostReporter).toBeTypeOf("function");
    expect(tuiReporter).toBe(hostReporter);
    expect(writes.at(-1)).toBe("\r\u001B[K");
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("eve dev local server ownership", () => {
  it("uses the host's canonical root and leaves an attached server running", async () => {
    const startHost = vi.fn(() => ({
      start: async () => ({
        kind: "existing" as const,
        appRoot: "/canonical/app",
        url: "http://127.0.0.1:4321/",
      }),
      close: async () => {},
    }));
    const runDevelopmentTui = vi.fn(async () => {});

    await withInteractiveTerminal(() =>
      runCli(["dev"], { error: () => {}, log: () => {} }, { runDevelopmentTui, startHost }),
    );

    expect(startHost).toHaveBeenCalledWith(expect.any(String), {
      existing: "attach-if-unconfigured",
      host: undefined,
      onBootProgress: expect.any(Function),
      port: undefined,
    });
    expect(runDevelopmentTui).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "App",
        target: {
          kind: "local",
          serverUrl: "http://127.0.0.1:4321/",
          workspaceRoot: "/canonical/app",
        },
      }),
    );
  });

  it("closes a server started for the interactive TUI", async () => {
    const close = vi.fn(async () => {});
    const startHost = vi.fn(() => ({
      start: async () => ({
        kind: "started" as const,
        appRoot: "/canonical/app",
        url: "http://127.0.0.1:4321/",
      }),
      close,
    }));

    await withInteractiveTerminal(() =>
      runCli(
        ["dev"],
        { error: () => {}, log: () => {} },
        { runDevelopmentTui: vi.fn(async () => {}), startHost },
      ),
    );
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("resolveDevUiMode", () => {
  it("defaults to the terminal UI in an interactive terminal", () => {
    expect(resolveDevUiMode({ options: {}, interactive: true })).toBe("tui");
  });

  it("forces headless when --no-ui is set", () => {
    expect(resolveDevUiMode({ options: { ui: false }, interactive: true })).toBe("headless");
  });

  it("forces headless in a non-interactive terminal regardless of flags", () => {
    expect(resolveDevUiMode({ options: {}, interactive: false })).toBe("headless");
  });
});

describe("resolveTuiDisplayOptions", () => {
  it("defaults tools to auto-collapsed, reasoning to full, and stderr logs visible", () => {
    expect(resolveTuiDisplayOptions({})).toEqual({
      logs: "stderr",
      reasoning: "full",
      tools: "auto-collapsed",
    });
  });

  it("passes through every provided display dimension", () => {
    expect(
      resolveTuiDisplayOptions({
        tools: "hidden",
        reasoning: "collapsed",
        subagents: "auto-collapsed",
        connectionAuth: "full",
        assistantResponseStats: "tokens",
        contextSize: 200_000,
        logs: "stderr",
      }),
    ).toEqual({
      tools: "hidden",
      reasoning: "collapsed",
      subagents: "auto-collapsed",
      connectionAuth: "full",
      assistantResponseStats: "tokens",
      contextSize: 200_000,
      logs: "stderr",
    });
  });

  it("omits optional display dimensions that were not provided", () => {
    const resolved = resolveTuiDisplayOptions({ tools: "full" });
    expect(resolved).not.toHaveProperty("subagents");
    expect(resolved).not.toHaveProperty("contextSize");
    expect(resolved.logs).toBe("stderr");
  });
});
