import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { HumanActionRequiredError } from "#setup/human-action.js";

import { ensureVercelProject } from "./ensure-vercel-project.js";

describe("ensureVercelProject", () => {
  it("returns an existing on-disk link without prompting", async () => {
    const fake = createFakePrompter();
    const readProjectLink = vi.fn(async () => ({ orgId: "team", projectId: "prj" }));

    await expect(
      ensureVercelProject({
        appRoot: "/project",
        prompter: fake.prompter,
        deps: { readProjectLink },
      }),
    ).resolves.toEqual({ orgId: "team", projectId: "prj" });
    expect(fake.selectMessages).toEqual([]);
  });

  it("headless without a link fails closed with vercel-link action required", async () => {
    const fake = createFakePrompter();
    const readProjectLink = vi.fn(async () => undefined);

    await expect(
      ensureVercelProject({
        appRoot: "/project",
        prompter: fake.prompter,
        headless: true,
        deps: { readProjectLink },
      }),
    ).rejects.toMatchObject({
      name: "HumanActionRequiredError",
      action: {
        kind: "vercel-link",
        command: "vercel link",
      },
    });
    expect(fake.selectMessages).toEqual([]);
  });

  it("headless HumanActionRequiredError is instanceof the public error class", async () => {
    const fake = createFakePrompter();
    await expect(
      ensureVercelProject({
        appRoot: "/project",
        prompter: fake.prompter,
        headless: true,
        deps: { readProjectLink: vi.fn(async () => undefined) },
      }),
    ).rejects.toBeInstanceOf(HumanActionRequiredError);
  });
});
