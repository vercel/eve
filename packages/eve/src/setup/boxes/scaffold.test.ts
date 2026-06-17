import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import type { Prompter } from "../prompter.js";
import { createDefaultSetupState, type SetupState } from "../state.js";
import type { OutputSink } from "../step.js";
import { runHeadless, runInteractive } from "../runner.js";
import { scaffold, type ScaffoldDeps } from "./scaffold.js";

const silentSink: OutputSink = { write: () => {} };
const TEST_EVE_PACKAGE = { version: "latest", nodeEngine: ">=24" } as const;

function fakeDeps(overrides: Partial<ScaffoldDeps> = {}): ScaffoldDeps {
  return {
    scaffoldBaseProject: vi.fn(async () => "/tmp/my-agent"),
    isEveProject: vi.fn(async () => false),
    ...overrides,
  };
}

function createPrompter(): Prompter {
  return createFakePrompter().prompter;
}

function resolvedState(): SetupState {
  return {
    ...createDefaultSetupState(),
    agentName: "my-agent",
    modelId: "openai/gpt-5-mini",
    projectPath: { kind: "resolved", inPlace: false, path: "/tmp/my-agent" },
  };
}

describe("scaffold box", () => {
  it("scaffolds the agent template and records the scaffolded path", async () => {
    const deps = fakeDeps({ scaffoldBaseProject: vi.fn(async () => "/tmp/elsewhere/my-agent") });
    const box = scaffold({
      prompter: createPrompter(),
      evePackage: TEST_EVE_PACKAGE,
      targetDirectory: "/tmp/parent",
      headless: true,
      deps,
    });

    const next = await runHeadless([box], resolvedState(), silentSink);

    expect(deps.scaffoldBaseProject).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: "my-agent",
        model: "openai/gpt-5-mini",
        byokProvider: false,
        targetDirectory: "/tmp/parent",
        evePackage: TEST_EVE_PACKAGE,
      }),
    );
    // apply re-writes the path to the one actually scaffolded.
    expect(next.projectPath).toEqual({
      kind: "resolved",
      inPlace: false,
      path: "/tmp/elsewhere/my-agent",
    });
  });

  it("scaffolds into the current directory for an in-place run", async () => {
    const deps = fakeDeps();
    const box = scaffold({
      prompter: createPrompter(),
      evePackage: TEST_EVE_PACKAGE,
      headless: true,
      deps,
    });
    const state: SetupState = {
      ...resolvedState(),
      projectPath: { kind: "resolved", inPlace: true, path: "/tmp/my-agent" },
    };

    const next = await runHeadless([box], state, silentSink);

    expect(deps.scaffoldBaseProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectName: "." }),
    );
    expect(next.projectPath).toEqual({ kind: "resolved", inPlace: true, path: "/tmp/my-agent" });
  });

  it("scaffolds an inline byok provider block when the model is self-wired", async () => {
    const deps = fakeDeps();
    const box = scaffold({
      prompter: createPrompter(),
      evePackage: TEST_EVE_PACKAGE,
      headless: true,
      deps,
    });
    const state: SetupState = { ...resolvedState(), modelWiring: "self" };

    await runHeadless([box], state, silentSink);

    expect(deps.scaffoldBaseProject).toHaveBeenCalledWith(
      expect.objectContaining({ byokProvider: true }),
    );
  });

  it("headless re-run on an existing eve project skips scaffolding and continues", async () => {
    const deps = fakeDeps({ isEveProject: vi.fn(async () => true) });
    const prompter = createPrompter();
    const box = scaffold({ prompter, evePackage: TEST_EVE_PACKAGE, headless: true, deps });

    const next = await runHeadless([box], resolvedState(), silentSink);

    expect(deps.scaffoldBaseProject).not.toHaveBeenCalled();
    expect(prompter.log.message).toHaveBeenCalledWith(
      "Existing eve project detected; continuing setup...",
    );
    expect(next.projectPath).toEqual({ kind: "resolved", inPlace: false, path: "/tmp/my-agent" });
  });

  it("interactive run scaffolds even when the directory is already an eve project", async () => {
    const deps = fakeDeps({ isEveProject: vi.fn(async () => true) });
    const box = scaffold({ prompter: createPrompter(), evePackage: TEST_EVE_PACKAGE, deps });

    const result = await runInteractive([box], resolvedState(), silentSink);

    expect(result.kind).toBe("done");
    expect(deps.scaffoldBaseProject).toHaveBeenCalledTimes(1);
  });

  it("headless overwriteExisting re-scaffolds an existing eve project and warns per overwrite", async () => {
    const deps = fakeDeps({ isEveProject: vi.fn(async () => true) });
    const prompter = createPrompter();
    const box = scaffold({
      prompter,
      evePackage: TEST_EVE_PACKAGE,
      overwriteExisting: true,
      headless: true,
      deps,
    });

    await runHeadless([box], resolvedState(), silentSink);

    expect(deps.scaffoldBaseProject).toHaveBeenCalledWith(
      expect.objectContaining({ overwriteExisting: true }),
    );
    const call = vi.mocked(deps.scaffoldBaseProject).mock.calls[0]?.[0];
    await call?.onOverwriteFile?.("agent/agent.ts");
    expect(prompter.log.warning).toHaveBeenCalledWith("Overwrote agent/agent.ts");
  });
});
