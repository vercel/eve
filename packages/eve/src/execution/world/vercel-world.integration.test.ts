import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { vercelWorld } from "./vercel-world.js";

// What `vercelWorld` needs before it talks to Vercel: a project, a token, and an environment
// Workflow Server has runs in. Nothing here reaches the network.

describe("vercelWorld", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eve-vercel-world-"));
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    vi.stubEnv("XDG_DATA_HOME", join(dir, "data"));
    vi.stubEnv("VERCEL_TOKEN", "");
    delete process.env.VERCEL_TOKEN;
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");
    delete process.env.VERCEL_DEPLOYMENT_ID;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("refuses the development environment, which has no runs", async () => {
    const world = vercelWorld({ environment: "development" as "preview", token: "t" });
    await expect(world.getDeploymentId()).rejects.toThrow('"development" environment');
  });

  it("needs a project outside a deployment", async () => {
    await expect(vercelWorld({ token: "t" }).getDeploymentId()).rejects.toThrow("vercel link");
  });

  it("needs a token outside a deployment", async () => {
    const world = vercelWorld({ projectId: "prj_1", teamId: "team_1" });
    await expect(world.getDeploymentId()).rejects.toThrow("needs a Vercel token");
  });

  it("takes the linked project and the CLI's login, and names its own deployment", async () => {
    mkdirSync(join(dir, ".vercel"));
    writeFileSync(
      join(dir, ".vercel", "project.json"),
      JSON.stringify({ orgId: "team_1", projectId: "prj_1" }),
    );
    mkdirSync(join(dir, "data", "com.vercel.cli"), { recursive: true });
    writeFileSync(join(dir, "data", "com.vercel.cli", "auth.json"), JSON.stringify({ token: "t" }));
    await expect(vercelWorld().getDeploymentId()).resolves.toBe("dpl_eve_in_process");
  });

  it("is the deployment's own World inside a deployment", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_running");
    await expect(vercelWorld().getDeploymentId()).resolves.toBe("dpl_running");
  });
});
