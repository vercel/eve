import { describe, expect, it, vi } from "vitest";

import { resolveDevUiMode, resolveTuiDisplayOptions, resolveTuiTitle, runCli } from "#cli/run.js";

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
        serverUrl: "https://example.com/",
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
        serverUrl: "https://example.com/",
      }),
    );
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

describe("resolveTuiTitle", () => {
  it("humanizes the app folder name for a local server", () => {
    expect(
      resolveTuiTitle({
        name: undefined,
        remoteServerUrl: undefined,
        appRoot: "/x/apps/fixtures/weather-agent",
      }),
    ).toBe("Weather Agent");
  });

  it("uses the remote host when connecting to a URL", () => {
    expect(
      resolveTuiTitle({
        name: undefined,
        remoteServerUrl: "https://example.com:8080",
        appRoot: "/x",
      }),
    ).toBe("example.com:8080");
  });

  it("prefers an explicit --name over both", () => {
    expect(
      resolveTuiTitle({
        name: "Custom",
        remoteServerUrl: "https://example.com",
        appRoot: "/x/weather-agent",
      }),
    ).toBe("Custom");
  });
});
