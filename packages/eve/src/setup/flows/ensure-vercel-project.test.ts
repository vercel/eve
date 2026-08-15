import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { WizardCancelledError } from "#setup/step.js";

import { ensureVercelProject } from "./ensure-vercel-project.js";

describe("ensureVercelProject", () => {
  it("logs in before reusing an existing project link", async () => {
    const project = { orgId: "team", projectId: "project" };
    const runLoginFlow = vi.fn(async () => ({ kind: "logged-in" as const }));
    const readProjectLink = vi.fn(async () => project);
    const { prompter } = createFakePrompter();

    await expect(
      ensureVercelProject({
        appRoot: "/project",
        prompter,
        deps: { readProjectLink, runLoginFlow },
      }),
    ).resolves.toBe(project);

    expect(runLoginFlow).toHaveBeenCalledWith({
      appRoot: "/project",
      prompter,
      signal: undefined,
    });
    expect(readProjectLink).toHaveBeenCalledOnce();
  });

  it("cancels before project selection when login is cancelled", async () => {
    const readProjectLink = vi.fn();

    await expect(
      ensureVercelProject({
        appRoot: "/project",
        prompter: createFakePrompter().prompter,
        deps: {
          readProjectLink,
          runLoginFlow: vi.fn(async () => ({ kind: "cancelled" as const })),
        },
      }),
    ).rejects.toBeInstanceOf(WizardCancelledError);

    expect(readProjectLink).not.toHaveBeenCalled();
  });
});
