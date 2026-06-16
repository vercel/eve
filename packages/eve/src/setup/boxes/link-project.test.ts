import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import type { Prompter } from "../prompter.js";
import { createDefaultSetupState, type SetupState } from "../state.js";
import type { OutputSink } from "../step.js";
import { runHeadless } from "../runner.js";
import { linkVercelProject, type LinkProjectDeps } from "./link-project.js";

const silentSink: OutputSink = { write: () => {} };

function fakeDeps(overrides: Partial<LinkProjectDeps> = {}): LinkProjectDeps {
  return {
    linkProject: vi.fn(async () => true),
    detectProjectResolution: vi.fn(async () => ({
      kind: "linked" as const,
      projectId: "prj_my_agent",
    })),
    resolveProjectByNameOrId: vi.fn(async () => ({ id: "prj_my_agent", name: "my-agent" })),
    unresolvedProject: vi.fn(() => ({ kind: "unresolved" as const })),
    ...overrides,
  };
}

function createPrompter(): Prompter {
  return createFakePrompter().prompter;
}

function resolvedState(): SetupState {
  return {
    ...createDefaultSetupState(),
    projectPath: { kind: "resolved", inPlace: false, path: "/tmp/project" },
  };
}

describe("linkVercelProject box", () => {
  it("re-links to the planned project even when a different link already exists", async () => {
    const prompter = createPrompter();
    const deps = fakeDeps();
    const state = resolvedState();
    state.vercelProject = { kind: "new", project: "my-agent", team: "team" };
    // A stale, mismatched link from a prior run must not win over the plan.
    state.project = { kind: "linked", projectId: "prj_stale" };
    const box = linkVercelProject({ prompter, deps });

    const next = await runHeadless([box], state, silentSink);

    expect(deps.linkProject).toHaveBeenCalledTimes(1);
    expect(deps.linkProject).toHaveBeenCalledWith(
      prompter,
      "/tmp/project",
      { kind: "new", project: "my-agent", team: "team" },
      expect.anything(),
      { signal: undefined },
    );
    expect(next.project).toEqual({ kind: "linked", projectId: "prj_my_agent" });
  });

  it("does not run when no Vercel project is planned", async () => {
    const deps = fakeDeps();
    const box = linkVercelProject({ prompter: createPrompter(), deps });
    const state = resolvedState();

    const next = await runHeadless([box], state, silentSink);

    expect(deps.linkProject).not.toHaveBeenCalled();
    expect(next.project).toEqual({ kind: "unresolved" });
  });

  it("throws when linkProject does not complete", async () => {
    const deps = fakeDeps({ linkProject: vi.fn(async () => false) });
    const state = resolvedState();
    state.vercelProject = { kind: "existing", project: "my-agent", team: "team" };
    const box = linkVercelProject({ prompter: createPrompter(), deps });

    await expect(runHeadless([box], state, silentSink)).rejects.toThrow(
      /provisioning did not complete/,
    );
    expect(deps.detectProjectResolution).not.toHaveBeenCalled();
  });

  it("throws when the post-link resolution stays unresolved", async () => {
    const deps = fakeDeps({
      detectProjectResolution: vi.fn(async () => ({ kind: "unresolved" as const })),
    });
    const state = resolvedState();
    state.vercelProject = { kind: "existing", project: "my-agent", team: "team" };
    const box = linkVercelProject({ prompter: createPrompter(), deps });

    await expect(runHeadless([box], state, silentSink)).rejects.toThrow(
      /could not resolve the Vercel project/,
    );
  });

  it("throws when the linked identity does not match the planned project", async () => {
    const deps = fakeDeps({
      detectProjectResolution: vi.fn(async () => ({
        kind: "linked" as const,
        projectId: "prj_other",
      })),
    });
    const state = resolvedState();
    state.vercelProject = { kind: "existing", project: "my-agent", team: "team" };
    const box = linkVercelProject({ prompter: createPrompter(), deps });

    await expect(runHeadless([box], state, silentSink)).rejects.toThrow(
      /identity did not match the planned Vercel project "my-agent"/,
    );
  });
});
