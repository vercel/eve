import { ChildProcess, spawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakePrompter, type FakePrompterConfig } from "#internal/testing/fake-prompter.js";

import {
  replSpawnPlan,
  selectInitHandoff,
  spawnCodingAgentRepl,
  type CodingAgentRepl,
  type InitReplDependencies,
} from "./init-repl.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

const mockedSpawn = vi.mocked(spawn);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function dependencies(
  input: {
    available?: readonly string[];
    interactive?: boolean;
    onSelect?: FakePrompterConfig["single"];
  } = {},
): InitReplDependencies {
  const fake = createFakePrompter({ single: input.onSelect });
  return {
    createPrompter: vi.fn(() => fake.prompter),
    hasInteractiveTerminal: vi.fn(() => input.interactive ?? true),
    isCodingAgentReplAvailable: vi.fn(
      async (command) => input.available?.includes(command) ?? false,
    ),
  };
}

describe("selectInitHandoff", () => {
  it("keeps non-interactive sessions on the direct eve dev path", async () => {
    const deps = dependencies({ interactive: false, available: ["claude"] });

    await expect(selectInitHandoff({ deps, agentName: "weather-bot" })).resolves.toBe("eve-dev");
    expect(deps.isCodingAgentReplAvailable).not.toHaveBeenCalled();
    expect(deps.createPrompter).not.toHaveBeenCalled();
  });

  it("keeps the direct eve dev path when no supported REPL is installed", async () => {
    const deps = dependencies();

    await expect(selectInitHandoff({ deps, agentName: "weather-bot" })).resolves.toBe("eve-dev");
    expect(
      vi.mocked(deps.isCodingAgentReplAvailable).mock.calls.map(([command]) => command),
    ).toEqual(["claude", "codex", "cursor-agent", "droid", "gemini", "opencode", "pi"]);
    expect(deps.createPrompter).not.toHaveBeenCalled();
  });

  it("starts every availability check before waiting for one to finish", async () => {
    let releaseAvailabilityChecks: () => void;
    const availabilityGate = new Promise<void>((resolve) => {
      releaseAvailabilityChecks = resolve;
    });
    const isCodingAgentReplAvailable = vi.fn(async (_command: CodingAgentRepl) => {
      await availabilityGate;
      return false;
    });
    const deps: InitReplDependencies = {
      createPrompter: vi.fn(),
      hasInteractiveTerminal: vi.fn(() => true),
      isCodingAgentReplAvailable,
    };

    const handoff = selectInitHandoff({ deps, agentName: "weather-bot" });
    const checksStartedBeforeAnyFinished = isCodingAgentReplAvailable.mock.calls.length;
    releaseAvailabilityChecks!();

    await expect(handoff).resolves.toBe("eve-dev");
    expect(checksStartedBeforeAnyFinished).toBe(7);
  });

  it("offers only available REPLs and preserves eve dev as the default", async () => {
    const deps = dependencies({
      available: ["codex"],
      onSelect: (options) => {
        expect(options.message).toBe("How would you like to continue?");
        expect(options.initialValue).toBe("eve-dev");
        expect(options.options.map((option) => option.value)).toEqual(["eve-dev", "codex"]);
        expect(options.options.map((option) => option.focusHint)).toEqual([
          "talk to 'weather-bot' in your terminal",
          "build 'weather-bot' using Codex",
        ]);
        // Hints are focus-only, like the dev TUI lists, so no always-on hint is set.
        expect(options.options.every((option) => option.hint === undefined)).toBe(true);
        return "codex";
      },
    });

    await expect(selectInitHandoff({ deps, agentName: "weather-bot" })).resolves.toBe("codex");
  });
});

describe("replSpawnPlan", () => {
  // A prompt with the newline and cmd metacharacters that break a shell launch.
  const PROMPT = "line one\nline two (with parens) & a pipe |";

  // Each REPL seeds its prompt differently once spawned shell-free: most take a
  // bare positional prompt, Gemini needs `-i`, opencode needs `--prompt`.
  it.each([
    { command: "claude", args: [PROMPT] },
    { command: "codex", args: [PROMPT] },
    { command: "cursor-agent", args: [PROMPT] },
    { command: "droid", args: [PROMPT] },
    { command: "gemini", args: ["-i", PROMPT] },
    { command: "opencode", args: ["--prompt", PROMPT] },
    { command: "pi", args: [PROMPT] },
  ] as const)("seeds $command verbatim when spawned shell-free", ({ command, args }) => {
    expect(replSpawnPlan(command, "/usr/local/bin/agent", PROMPT, "linux")).toEqual({
      file: "/usr/local/bin/agent",
      args,
      shell: false,
      seeded: true,
    });
  });

  it("spawns a resolved Windows .exe shell-free, prompt intact", () => {
    expect(replSpawnPlan("claude", "C:\\bin\\claude.EXE", PROMPT, "win32")).toEqual({
      file: "C:\\bin\\claude.EXE",
      args: [PROMPT],
      shell: false,
      seeded: true,
    });
  });

  it("launches a Windows .cmd shim bare, leaving the prompt unseeded", () => {
    expect(replSpawnPlan("claude", "C:\\bin\\claude.CMD", PROMPT, "win32")).toEqual({
      file: "claude",
      args: [],
      shell: true,
      seeded: false,
    });
  });

  it("launches bare when the command does not resolve", () => {
    expect(replSpawnPlan("claude", null, PROMPT, "linux")).toEqual({
      file: "claude",
      args: [],
      shell: false,
      seeded: false,
    });
    expect(replSpawnPlan("claude", null, PROMPT, "win32").shell).toBe(true);
  });
});

describe("spawnCodingAgentRepl", () => {
  const PROMPT = "Help the user build their eve agent.";

  async function awaitSpawn(): Promise<void> {
    await vi.waitFor(() => expect(mockedSpawn).toHaveBeenCalled());
  }

  it("spawns the resolved executable shell-free and resolves true on clean exit", async () => {
    const child = new ChildProcess();
    mockedSpawn.mockReturnValue(child);

    const result = spawnCodingAgentRepl({
      command: "claude",
      cwd: "/tmp/triage-bot",
      prompt: PROMPT,
      resolvePath: async () => "/usr/local/bin/claude",
    });
    await awaitSpawn();
    child.emit("close", 0);

    await expect(result).resolves.toBe(true);
    expect(mockedSpawn).toHaveBeenCalledWith(
      "/usr/local/bin/claude",
      [PROMPT],
      expect.objectContaining({ cwd: "/tmp/triage-bot", shell: false, stdio: "inherit" }),
    );
  });

  it("surfaces the prompt and launches bare when the command cannot be seeded", async () => {
    const child = new ChildProcess();
    mockedSpawn.mockReturnValue(child);
    const onPromptUnseeded = vi.fn();

    const result = spawnCodingAgentRepl({
      command: "claude",
      cwd: "/tmp/triage-bot",
      prompt: PROMPT,
      resolvePath: async () => null,
      onPromptUnseeded,
    });
    await awaitSpawn();
    child.emit("close", 0);

    await expect(result).resolves.toBe(true);
    expect(onPromptUnseeded).toHaveBeenCalledWith(PROMPT);
    expect(mockedSpawn).toHaveBeenCalledWith(
      "claude",
      [],
      expect.objectContaining({ cwd: "/tmp/triage-bot", stdio: "inherit" }),
    );
  });

  it("resolves false when the spawn errors", async () => {
    const child = new ChildProcess();
    mockedSpawn.mockReturnValue(child);

    const result = spawnCodingAgentRepl({
      command: "claude",
      cwd: "/tmp/triage-bot",
      prompt: PROMPT,
      resolvePath: async () => "/usr/local/bin/claude",
    });
    await awaitSpawn();
    child.emit("error", new Error("spawn failed"));

    await expect(result).resolves.toBe(false);
  });
});
