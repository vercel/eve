import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import { headlessAsker, InteractionRequired, type Asker } from "../ask.js";
import { interactiveAsker } from "../ask.js";
import type { Prompter, PrompterValue } from "../prompter.js";
import { createDefaultSetupState } from "../state.js";
import type { OutputSink } from "../step.js";
import { runHeadless, runInteractive } from "../runner.js";
import { resolveTarget, type ResolveTargetDeps } from "./resolve-target.js";

const silentSink: OutputSink = { write: () => {} };

const deps: ResolveTargetDeps = {
  pathExists: vi.fn(async () => false),
  isEveProject: vi.fn(async () => false),
};
const mockedPathExists = vi.mocked(deps.pathExists);
const mockedIsEveProject = vi.mocked(deps.isEveProject);

function unexpectedPrompt(): never {
  throw new Error("Unexpected prompt in a resolve-target test.");
}

/** An interactive asker over a scripted prompter, plus its notice spy. */
function createAsker(options: { textValues?: string[]; selectValues?: PrompterValue[] } = {}): {
  asker: Asker;
  prompter: Prompter;
} {
  const textValues = [...(options.textValues ?? [])];
  const selectValues = [...(options.selectValues ?? [])];
  const prompter = createFakePrompter({
    text: () => textValues.shift() ?? unexpectedPrompt(),
    single: () => selectValues.shift() ?? unexpectedPrompt(),
  }).prompter;
  return { asker: interactiveAsker(prompter), prompter };
}

describe("resolveTarget box", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPathExists.mockResolvedValue(false);
    mockedIsEveProject.mockResolvedValue(false);
  });

  it("resolves the project path before scaffold writes it", async () => {
    const { asker, prompter } = createAsker();
    const box = resolveTarget({
      asker,
      notify: prompter.note,
      presetName: "my-agent",
      targetDirectory: "/tmp/parent",
      deps,
    });

    const result = await runInteractive([box], createDefaultSetupState(), silentSink);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.agentName).toBe("my-agent");
    expect(result.state.projectPath).toEqual({
      kind: "resolved",
      inPlace: false,
      path: "/tmp/parent/my-agent",
    });
  });

  it("rejects a preset name whose directory already exists", async () => {
    mockedPathExists.mockImplementation(async (path) => path === "/tmp/parent/demo-agent");
    const { asker, prompter } = createAsker();
    const box = resolveTarget({
      asker,
      notify: prompter.note,
      presetName: "demo-agent",
      targetDirectory: "/tmp/parent",
      deps,
    });

    await expect(runInteractive([box], createDefaultSetupState(), silentSink)).rejects.toThrow(
      'Directory "demo-agent" already exists',
    );
  });

  it("resumes an existing eve project when the composition opted in (headless re-runs)", async () => {
    mockedPathExists.mockImplementation(async (path) => path === "/tmp/parent/demo-agent");
    mockedIsEveProject.mockResolvedValue(true);
    const box = resolveTarget({
      asker: headlessAsker(),
      notify: unexpectedPrompt,
      presetName: "demo-agent",
      targetDirectory: "/tmp/parent",
      resumeExisting: true,
      deps,
    });

    await expect(runHeadless([box], createDefaultSetupState(), silentSink)).resolves.toMatchObject({
      projectPath: { kind: "resolved", inPlace: false, path: "/tmp/parent/demo-agent" },
    });
  });

  it("still refuses an existing directory that is not an eve project, even when resumable", async () => {
    mockedPathExists.mockImplementation(async (path) => path === "/tmp/parent/demo-agent");
    mockedIsEveProject.mockResolvedValue(false);
    const box = resolveTarget({
      asker: headlessAsker(),
      notify: unexpectedPrompt,
      presetName: "demo-agent",
      targetDirectory: "/tmp/parent",
      resumeExisting: true,
      deps,
    });

    await expect(runHeadless([box], createDefaultSetupState(), silentSink)).rejects.toThrow(
      'Directory "demo-agent" already exists',
    );
  });

  it("headless without a preset name refuses with InteractionRequired naming the question", async () => {
    const box = resolveTarget({
      asker: headlessAsker(),
      notify: unexpectedPrompt,
      targetDirectory: "/tmp/parent",
      deps,
    });

    await expect(runHeadless([box], createDefaultSetupState(), silentSink)).rejects.toThrow(
      InteractionRequired,
    );
    await expect(runHeadless([box], createDefaultSetupState(), silentSink)).rejects.toMatchObject({
      message: expect.stringMatching(/What's your agent's name\?/),
      question: expect.objectContaining({ key: "name", required: true }),
    });
  });

  it("checks interactive project names relative to the target directory", async () => {
    mockedPathExists.mockImplementation(async (path) => path === "/tmp/parent/demo-agent");
    const { asker, prompter } = createAsker({ textValues: ["demo-agent", "demo-agent-2"] });
    const box = resolveTarget({
      asker,
      notify: prompter.note,
      targetDirectory: "/tmp/parent",
      deps,
    });

    const result = await runInteractive([box], createDefaultSetupState(), silentSink);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.projectPath).toEqual({
      kind: "resolved",
      inPlace: false,
      path: "/tmp/parent/demo-agent-2",
    });
    expect(mockedPathExists).toHaveBeenCalledWith("/tmp/parent/demo-agent");
    expect(mockedPathExists).toHaveBeenCalledWith("/tmp/parent/demo-agent-2");
    expect(prompter.note).toHaveBeenCalledWith(
      'Directory "demo-agent" already exists. Choose a different name.',
    );
  });

  it("resolves in-place scaffolds to the target directory itself", async () => {
    const { asker, prompter } = createAsker();
    const box = resolveTarget({
      asker,
      notify: prompter.note,
      targetDirectory: "/tmp/parent",
      inPlace: true,
      deps,
    });

    const result = await runInteractive([box], createDefaultSetupState(), silentSink);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.projectPath).toEqual({
      kind: "resolved",
      inPlace: true,
      path: "/tmp/parent",
    });
  });

  it("asks for the agent name when an interactive in-place basename is not a valid slug", async () => {
    const { asker, prompter } = createAsker({ textValues: ["my-agent"] });
    const box = resolveTarget({
      asker,
      notify: prompter.note,
      targetDirectory: "/tmp/My Project",
      inPlace: true,
      deps,
    });

    const result = await runInteractive([box], createDefaultSetupState(), silentSink);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.agentName).toBe("my-agent");
    expect(result.state.projectPath).toEqual({
      kind: "resolved",
      inPlace: true,
      path: "/tmp/My Project",
    });
  });

  it("headless in-place still refuses an invalid basename", async () => {
    const box = resolveTarget({
      asker: headlessAsker(),
      notify: unexpectedPrompt,
      targetDirectory: "/tmp/My Project",
      inPlace: true,
      deps,
    });

    await expect(runHeadless([box], createDefaultSetupState(), silentSink)).rejects.toThrow(
      /Cannot infer a valid project name/,
    );
  });
});
