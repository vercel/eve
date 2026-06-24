import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VercelCaptureResult } from "#setup/primitives/index.js";

import {
  resolveVercelDeployment,
  type VercelDeploymentResolutionDeps,
} from "./vercel-deployment.js";

beforeEach(() => {
  vi.stubEnv("VERCEL_ORG_ID", "");
  vi.stubEnv("VERCEL_PROJECT_ID", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveVercelDeployment", () => {
  it("uses a complete Vercel project environment before the on-disk link", async () => {
    vi.stubEnv("VERCEL_ORG_ID", "team_env");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_env");
    const readProjectLink = vi.fn<VercelDeploymentResolutionDeps["readProjectLink"]>(async () => ({
      orgId: "team_link",
      projectId: "prj_link",
    }));
    const captureVercel = vi.fn<VercelDeploymentResolutionDeps["captureVercel"]>(async () => ({
      ok: true,
      stdout: JSON.stringify({
        projectId: "prj_env",
        name: "inbound",
        target: "preview",
      }),
    }));

    await expect(
      resolveVercelDeployment({
        workspaceRoot: "/repo",
        host: "inbound.example.com",
        deps: { captureVercel, readProjectLink },
      }),
    ).resolves.toMatchObject({
      kind: "resolved",
      target: {
        deployment: { ownerId: "team_env", projectId: "prj_env" },
      },
    });
    expect(readProjectLink).not.toHaveBeenCalled();
  });

  it("resolves a standard deployment whose custom environment is null", async () => {
    const response: VercelCaptureResult = {
      ok: true,
      stdout: JSON.stringify({
        projectId: "prj_target",
        name: "inbound",
        target: null,
        customEnvironment: null,
      }),
    };
    const captureVercel = vi.fn<VercelDeploymentResolutionDeps["captureVercel"]>(
      async () => response,
    );

    const resolution = await resolveVercelDeployment({
      workspaceRoot: "/repo",
      host: "inbound.example.com",
      deps: {
        captureVercel,
        readProjectLink: async () => ({ orgId: "team_a", projectId: "prj_target" }),
      },
    });

    expect(resolution).toMatchObject({
      kind: "resolved",
      target: {
        origin: "https://inbound.example.com",
        deployment: {
          provider: "vercel",
          ownerId: "team_a",
          projectId: "prj_target",
          projectName: "inbound",
          environment: "preview",
        },
      },
    });

    expect(captureVercel).toHaveBeenCalledWith(
      ["api", "/v13/deployments/inbound.example.com", "--scope", "team_a", "--raw"],
      expect.objectContaining({ cwd: "/repo", nonInteractive: true, timeoutMs: 10_000 }),
    );
  });

  it("distinguishes not-found, operational, and invalid-response failures", async () => {
    const captures: VercelCaptureResult[] = [
      {
        ok: true,
        stdout: JSON.stringify({ error: { code: "not_found", message: "missing" } }),
      },
      {
        ok: false,
        failure: {
          code: null,
          stdout: "",
          stderr: "",
          message: "vercel api timed out.",
        },
      },
      { ok: true, stdout: "not json" },
      { ok: true, stdout: JSON.stringify({ projectId: "prj_target" }) },
    ];
    const captureVercel = vi.fn<VercelDeploymentResolutionDeps["captureVercel"]>(async () => {
      const result = captures.shift();
      if (result === undefined) throw new Error("Unexpected Vercel lookup");
      return result;
    });
    const input = {
      workspaceRoot: "/repo",
      host: "inbound.example.com",
      source: { orgId: "team_a", projectId: "prj_target" },
      deps: { captureVercel },
    };

    await expect(resolveVercelDeployment(input)).resolves.toEqual({ kind: "not-found" });
    await expect(resolveVercelDeployment(input)).resolves.toMatchObject({
      kind: "failed",
      failure: { cause: "vercel", failure: { message: "vercel api timed out." } },
    });
    await expect(resolveVercelDeployment(input)).resolves.toEqual({
      kind: "failed",
      failure: {
        cause: "invalid-json",
        message: "Vercel returned invalid deployment JSON.",
      },
    });
    await expect(resolveVercelDeployment(input)).resolves.toEqual({
      kind: "failed",
      failure: {
        cause: "invalid-shape",
        message: "Vercel returned an invalid deployment response.",
      },
    });
  });

  it("rejects a deployment from a different project under the same owner", async () => {
    await expect(
      resolveVercelDeployment({
        workspaceRoot: "/repo",
        host: "other.example.com",
        source: { orgId: "team_a", projectId: "prj_source" },
        deps: {
          captureVercel: async () => ({
            ok: true,
            stdout: JSON.stringify({
              projectId: "prj_other",
              name: "other",
              target: "preview",
              customEnvironment: null,
            }),
          }),
        },
      }),
    ).resolves.toEqual({
      kind: "project-mismatch",
      expectedProjectId: "prj_source",
      actualProjectId: "prj_other",
    });
  });

  it("reports an unscoped lookup without invoking the Vercel CLI", async () => {
    const captureVercel = vi.fn<VercelDeploymentResolutionDeps["captureVercel"]>();

    await expect(
      resolveVercelDeployment({
        workspaceRoot: "/repo",
        host: "inbound.example.com",
        deps: {
          captureVercel,
          readProjectLink: async () => undefined,
        },
      }),
    ).resolves.toEqual({ kind: "unscoped" });
    expect(captureVercel).not.toHaveBeenCalled();
  });

  it("does not infer not-found from an operational error's command text", async () => {
    await expect(
      resolveVercelDeployment({
        workspaceRoot: "/repo",
        host: "preview-404.example.com",
        source: { orgId: "team_a", projectId: "prj_target" },
        deps: {
          captureVercel: async () => ({
            ok: false,
            failure: {
              code: 1,
              stdout: JSON.stringify({ error: { code: "forbidden", message: "Forbidden" } }),
              stderr: "",
              message: "vercel api /v13/deployments/preview-404.example.com exited with code 1.",
            },
          }),
        },
      }),
    ).resolves.toMatchObject({
      kind: "failed",
      failure: { cause: "vercel" },
    });
  });
});
