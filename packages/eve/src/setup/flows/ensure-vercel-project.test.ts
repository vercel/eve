import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import { ensureVercelProject } from "./ensure-vercel-project.js";

describe("ensureVercelProject", () => {
  it("headless returns an existing link without opening a flow", async () => {
    const readProjectLink = vi.fn(async () => ({ orgId: "team-id", projectId: "project-id" }));

    await expect(
      ensureVercelProject({
        appRoot: "/project",
        prompter: createFakePrompter().prompter,
        headless: true,
        deps: { readProjectLink },
      }),
    ).resolves.toEqual({ orgId: "team-id", projectId: "project-id" });
    expect(readProjectLink).toHaveBeenCalledTimes(1);
  });

  it("headless refuses to open the interactive linking flow when nothing is linked", async () => {
    const readProjectLink = vi.fn(async () => undefined);

    await expect(
      ensureVercelProject({
        appRoot: "/project",
        prompter: createFakePrompter().prompter,
        headless: true,
        deps: { readProjectLink },
      }),
    ).rejects.toThrow("not linked to a Vercel project");
    // The refusal happens before the interactive boxes run: the link probe is
    // the only read (the post-flow verification read never happens).
    expect(readProjectLink).toHaveBeenCalledTimes(1);
  });
});
