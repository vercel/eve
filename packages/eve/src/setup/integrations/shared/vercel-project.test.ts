import { describe, expect, it, vi } from "vitest";
import { resolveIntegrationVercelProject } from "./vercel-project.js";

describe("resolveIntegrationVercelProject", () => {
  it("returns an existing project link", async () => {
    await expect(
      resolveIntegrationVercelProject({
        appRoot: "/project",
        integration: "Slack",
        deps: { readProjectLink: vi.fn(async () => ({ orgId: "team", projectId: "project" })) },
      }),
    ).resolves.toEqual({ orgId: "team", projectId: "project" });
  });
  it("requires the caller to link an unresolved project", async () => {
    await expect(
      resolveIntegrationVercelProject({
        appRoot: "/project",
        integration: "Slack",
        deps: { readProjectLink: vi.fn(async () => undefined) },
      }),
    ).rejects.toMatchObject({
      prerequisite: { kind: "command", code: "vercel-project-link", command: "eve link" },
    });
  });
});
