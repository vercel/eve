import { ChildProcess, spawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakePrompter, type FakePrompterConfig } from "#internal/testing/fake-prompter.js";

import {
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

    await expect(selectInitHandoff({ deps })).resolves.toBe("eve-dev");
    expect(deps.isCodingAgentReplAvailable).not.toHaveBeenCalled();
    expect(deps.createPrompter).not.toHaveBeenCalled();
  });

  it("keeps the direct eve dev path when no supported REPL is installed", async () => {
    const deps = dependencies();

    await expect(selectInitHandoff({ deps })).resolves.toBe("eve-dev");
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

    const handoff = selectInitHandoff({ deps });
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
        return "codex";
      },
    });

    await expect(selectInitHandoff({ deps })).resolves.toBe("codex");
  });
});

describe("spawnCodingAgentRepl", () => {
  const PROMPT = "Help the user build their eve agent.";

  // Each REPL seeds its prompt differently. Most take a bare positional prompt,
  // Gemini needs `-i`, opencode needs `--prompt`.
  it.each([
    { command: "claude", args: [PROMPT] },
    { command: "codex", args: [PROMPT] },
    { command: "cursor-agent", args: [PROMPT] },
    { command: "droid", args: [PROMPT] },
    { command: "gemini", args: ["-i", PROMPT] },
    { command: "opencode", args: ["--prompt", PROMPT] },
    { command: "pi", args: [PROMPT] },
  ] as const)("launches $command with its prompt argv", async ({ command, args }) => {
    const child = new ChildProcess();
    mockedSpawn.mockReturnValue(child);

    const result = spawnCodingAgentRepl({ command, cwd: "/tmp/triage-bot", prompt: PROMPT });
    child.emit("close", 0);

    await expect(result).resolves.toBe(true);
    expect(mockedSpawn).toHaveBeenCalledWith(
      command,
      args,
      expect.objectContaining({
        cwd: "/tmp/triage-bot",
        shell: process.platform === "win32",
        stdio: "inherit",
      }),
    );
  });
});
