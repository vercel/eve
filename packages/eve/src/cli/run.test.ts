import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { resolveDevUiMode, resolveTuiDisplayOptions, runCli } from "#cli/run.js";
import { MockScreen } from "#cli/dev/tui/test/mock-terminal.js";
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

async function runInteractiveDev(
  argv: string[],
  runtime: NonNullable<Parameters<typeof runCli>[2]> = {},
) {
  const runDevelopmentTui = vi.fn(async () => {});
  await withInteractiveTerminal(() =>
    runCli(argv, { error: () => {}, log: () => {} }, { ...runtime, runDevelopmentTui }),
  );
  return runDevelopmentTui;
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

  it("registers the diagnostic logs commands", async () => {
    const output: string[] = [];
    const logger = {
      error: (message: string) => output.push(message),
      log: (message: string) => output.push(message),
    };

    await runCli(["logs", "--help"], logger).catch(() => {});

    const help = output.join("\n");
    expect(help).toContain("show [options] [logid]");
    expect(help).toContain("ls");
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
    const runDevelopmentTui = await runInteractiveDev([
      "dev",
      "--url",
      "https://example.com",
      "--input",
      "/model",
    ]);

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
  it("preserves query parameters on the remote target URL", async () => {
    const runDevelopmentTui = await runInteractiveDev([
      "dev",
      "https://example.com?x-vercel-protection-bypass=secret",
    ]);

    expect(runDevelopmentTui).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          kind: "remote",
          serverUrl: "https://example.com/?x-vercel-protection-bypass=secret",
          workspaceRoot: process.cwd(),
        },
      }),
    );
  });

  it("lowers URL userinfo to a Basic authorization header and strips it from the target URL", async () => {
    const runDevelopmentTui = await runInteractiveDev([
      "dev",
      "https://test%40user:p%20ss@example.com",
    ]);

    expect(runDevelopmentTui).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: {
          Authorization: `Basic ${btoa("test@user:p ss")}`,
        },
        target: {
          kind: "remote",
          serverUrl: "https://example.com/",
          workspaceRoot: process.cwd(),
        },
      }),
    );
  });

  it("prefers explicit authorization headers over URL userinfo", async () => {
    const runDevelopmentTui = await runInteractiveDev([
      "dev",
      "https://user:pass@example.com",
      "-H",
      "Authorization: Bearer explicit-token",
    ]);

    expect(runDevelopmentTui).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: {
          Authorization: "Bearer explicit-token",
        },
        target: {
          kind: "remote",
          serverUrl: "https://example.com/",
          workspaceRoot: process.cwd(),
        },
      }),
    );
  });

  it("forwards repeatable request headers to the remote TUI", async () => {
    const runDevelopmentTui = await runInteractiveDev([
      "dev",
      "--url",
      "https://example.com",
      "-H",
      "Authorization: Basic dGVzdDpzZWNyZXQ=",
      "--header",
      "X-Tenant: acme",
    ]);

    expect(runDevelopmentTui).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: {
          Authorization: "Basic dGVzdDpzZWNyZXQ=",
          "X-Tenant": "acme",
        },
        target: {
          kind: "remote",
          serverUrl: "https://example.com/",
          workspaceRoot: process.cwd(),
        },
      }),
    );
  });

  it("rejects malformed request headers", async () => {
    await expect(
      runCli(
        ["dev", "--url", "https://example.com", "-H", "Authorization"],
        { error: () => {}, log: () => {} },
        { runDevelopmentTui: vi.fn(async () => {}) },
      ),
    ).rejects.toThrow('Expected header in "Name: value" format');
  });

  it("rejects request headers without a URL target", async () => {
    await expect(
      runCli(["dev", "-H", "Authorization: Bearer dev-token"], {
        error: () => {},
        log: () => {},
      }),
    ).rejects.toThrow("The --header option can only be used with --url or a bare URL.");
  });

  it("uses the local TUI credential path only for this app's running dev server", async () => {
    const runDevelopmentTui = await runInteractiveDev(["dev", "--url", "http://127.0.0.1:2000"], {
      isActiveDevelopmentServerForApp: async () => true,
    });

    expect(runDevelopmentTui).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          kind: "local",
          serverUrl: "http://127.0.0.1:2000/",
          workspaceRoot: process.cwd(),
        },
      }),
    );
  });

  it("keeps an unverified loopback URL on the remote credential path", async () => {
    const runDevelopmentTui = await runInteractiveDev(["dev", "--url", "http://127.0.0.1:2000"], {
      isActiveDevelopmentServerForApp: async () => false,
    });

    expect(runDevelopmentTui).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          kind: "remote",
          serverUrl: "http://127.0.0.1:2000/",
          workspaceRoot: process.cwd(),
        },
      }),
    );
  });

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
    const runDevelopmentTui = await runInteractiveDev([
      "dev",
      "--url",
      "https://example.com",
      "--logs",
      "sandbox",
    ]);

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
    // Replaying every write through a terminal emulator: the boot progress row
    // is erased, leaving a clean screen for the error to print onto.
    const screen = new MockScreen({ columns: 80, rows: 10 });
    screen.write(writes.join(""));
    expect(screen.snapshot()).toBe("");
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
    const runDevelopmentTui = await runInteractiveDev(["dev"], { startHost });

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

    await runInteractiveDev(["dev"], { startHost });
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("eve build output ownership", () => {
  it("forwards a profile path relative to the application root", async () => {
    const buildHost = vi.fn(async () => "/app/.output");
    const profilePath = ".eve/build-profiles/notes.json";

    await runCli(
      ["build", "--profile", profilePath],
      { error: () => {}, log: () => {} },
      { buildHost },
    );

    expect(buildHost).toHaveBeenCalledWith(process.cwd(), {
      profileOutputPath: resolve(process.cwd(), profilePath),
      skipVercelSandboxPrewarm: false,
      vercelServiceOutput: undefined,
    });
  });

  it("resolves the internal service output directory from the build working directory", async () => {
    const buildHost = vi.fn(async () => "/service/.vercel/output");
    const configuredDirectory = ".eve/vercel-services/eve/.vercel/output";
    const configuredHostDirectory = ".vercel/output";
    vi.stubEnv("EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY", configuredDirectory);
    vi.stubEnv("EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY", configuredHostDirectory);

    try {
      await runCli(["build"], { error: () => {}, log: () => {} }, { buildHost });
    } finally {
      vi.unstubAllEnvs();
    }

    expect(buildHost).toHaveBeenCalledWith(process.cwd(), {
      skipVercelSandboxPrewarm: false,
      vercelServiceOutput: {
        hostOutputDirectory: resolve(process.cwd(), configuredHostDirectory),
        serviceOutputDirectory: resolve(process.cwd(), configuredDirectory),
      },
    });
  });

  it("rejects an incomplete internal Vercel service output contract", async () => {
    vi.stubEnv("EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY", ".eve/vercel-services/eve/.vercel/output");

    try {
      await expect(
        runCli(["build"], { error: () => {}, log: () => {} }, { buildHost: vi.fn() }),
      ).rejects.toThrow(
        "EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY and EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY must be set together.",
      );
    } finally {
      vi.unstubAllEnvs();
    }
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
  it("defaults tools and reasoning to auto-collapsed with stderr logs visible", () => {
    expect(resolveTuiDisplayOptions({})).toEqual({
      logs: "stderr",
      // Collapsed reasoning is the fixed thinking line; `--reasoning full`
      // restores the streaming transcript trace.
      reasoning: "auto-collapsed",
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
