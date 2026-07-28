import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import type { Prompter } from "../prompter.js";
import { runHeadless } from "../runner.js";
import { createDefaultSetupState, type SetupState } from "../state.js";
import type { OutputSink } from "../step.js";
import {
  reconcileHostFrameworkPreset,
  type ReconcileHostFrameworkPresetDeps,
} from "./reconcile-host-framework-preset.js";

const silentSink: OutputSink = { write: () => {} };

function createPrompter(): Prompter {
  return createFakePrompter().prompter;
}

function fakeDeps(): ReconcileHostFrameworkPresetDeps {
  return { syncHostFrameworkPreset: vi.fn(async () => {}) };
}

function stateWith(overrides: Partial<SetupState>): SetupState {
  return {
    ...createDefaultSetupState(),
    projectPath: { kind: "resolved", inPlace: true, path: "/tmp/project" },
    deploymentPending: true,
    ...overrides,
  };
}

describe("reconcileHostFrameworkPreset box", () => {
  it("reconciles the preset when a web channel targets an already-linked project", async () => {
    const prompter = createPrompter();
    const deps = fakeDeps();
    const state = stateWith({
      channelSelection: ["web"],
      project: { kind: "linked", projectId: "prj_demo" },
    });

    await runHeadless([reconcileHostFrameworkPreset({ prompter, deps })], state, silentSink);

    expect(deps.syncHostFrameworkPreset).toHaveBeenCalledWith(
      prompter,
      "/tmp/project",
      expect.anything(),
      { signal: undefined },
    );
  });

  it("skips when no web channel is selected", async () => {
    const deps = fakeDeps();
    const state = stateWith({
      channelSelection: ["slack"],
      project: { kind: "linked", projectId: "prj_demo" },
    });

    await runHeadless(
      [reconcileHostFrameworkPreset({ prompter: createPrompter(), deps })],
      state,
      silentSink,
    );

    expect(deps.syncHostFrameworkPreset).not.toHaveBeenCalled();
  });

  it("skips when the project is not yet linked", async () => {
    const deps = fakeDeps();
    const state = stateWith({
      channelSelection: ["web"],
      project: { kind: "unresolved" },
    });

    await runHeadless(
      [reconcileHostFrameworkPreset({ prompter: createPrompter(), deps })],
      state,
      silentSink,
    );

    expect(deps.syncHostFrameworkPreset).not.toHaveBeenCalled();
  });

  it("skips when no deploy will follow (deploymentPending is false)", async () => {
    const deps = fakeDeps();
    const state = stateWith({
      channelSelection: ["web"],
      project: { kind: "linked", projectId: "prj_demo" },
      deploymentPending: false,
    });

    await runHeadless(
      [reconcileHostFrameworkPreset({ prompter: createPrompter(), deps })],
      state,
      silentSink,
    );

    expect(deps.syncHostFrameworkPreset).not.toHaveBeenCalled();
  });
});
