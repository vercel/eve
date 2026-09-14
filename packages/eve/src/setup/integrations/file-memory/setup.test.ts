import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker } from "#setup/ask.js";

import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import { applyFileMemorySetup, type FileMemorySetupDeps, prepareFileMemorySetup } from "./setup.js";
import type { FileMemoryBlobPlan } from "./vercel.js";

const plan: FileMemoryBlobPlan = {
  action: "create",
  project: { orgId: "team_acme", projectId: "prj_agent" },
  projectName: "agent",
  region: "iad1",
  storeName: "eve-memory-agent-prjagent",
};

function setup() {
  const fake = createFakePrompter();
  const resolveVercelProject = vi.fn(async () => plan.project);
  return {
    ...createSetupContexts({
      appRoot: "/project",
      asker: headlessAsker(),
      environment: integrationSetupEnvironment("authenticated", {
        kind: "linked",
        projectId: "prj_agent",
      }),
      prompter: fake.prompter,
      resolveVercelProject,
    }),
    fake,
    resolveVercelProject,
  };
}

function deps(): FileMemorySetupDeps {
  return {
    applyBlob: vi.fn(async () => ({
      action: "create" as const,
      store: {
        access: "private" as const,
        id: "store_memory",
        name: plan.storeName,
        region: "iad1",
        type: "blob",
      },
    })),
    prepareBlob: vi.fn(async () => plan),
  };
}

describe("file-memory setup", () => {
  it("resolves the Vercel project and remains read-only during prepare", async () => {
    const effects = deps();
    const context = setup();
    await expect(prepareFileMemorySetup(context.prepare, effects)).resolves.toBe(plan);
    expect(context.resolveVercelProject).toHaveBeenCalledWith("file memory");
    expect(effects.prepareBlob).toHaveBeenCalledWith({
      appRoot: "/project",
      project: plan.project,
      signal: undefined,
    });
    expect(effects.applyBlob).not.toHaveBeenCalled();
  });

  it("prints the mutation details and returns completion facts", async () => {
    const effects = deps();
    const context = setup();
    await expect(applyFileMemorySetup(plan, context.apply, effects)).resolves.toEqual({
      deploymentRequired: true,
      facts: [
        { label: "Blob store", value: plan.storeName },
        { label: "Vercel project", value: "agent" },
        { label: "Region", value: "iad1" },
        { label: "Environments", value: "production, preview, development" },
        { label: "Setup result", value: "Created" },
      ],
    });
    expect(context.fake.prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Blob usage may incur charges"),
      "File-memory storage",
    );
    expect(effects.applyBlob).toHaveBeenCalledOnce();
  });
});
