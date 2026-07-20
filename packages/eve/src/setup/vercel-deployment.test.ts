import { afterEach, describe, expect, it, vi } from "vitest";

import type { VercelCaptureResult } from "#setup/primitives/index.js";

import {
  resolveVercelDeployment,
  type VercelDeploymentResolutionDeps,
} from "./vercel-deployment.js";

afterEach(() => vi.restoreAllMocks());

const STANDARD = {
  ownerId: "team_a",
  projectId: "prj_target",
  name: "inbound",
  target: "production",
  customEnvironment: null,
};

describe("resolveVercelDeployment", () => {
  it("resolves from the host alone, without a scope, when no source is provided", async () => {
    const captureVercel = vi.fn<VercelDeploymentResolutionDeps["captureVercel"]>(async () => ({
      ok: true,
      stdout: JSON.stringify({ ...STANDARD, ownerId: "team_resolved" }),
    }));

    await expect(
      resolveVercelDeployment({
        workspaceRoot: "/repo",
        host: "inbound.example.com",
        deps: { captureVercel },
      }),
    ).resolves.toMatchObject({
      kind: "resolved",
      target: {
        origin: "https://inbound.example.com",
        deployment: {
          provider: "vercel",
          ownerId: "team_resolved",
          projectId: "prj_target",
          projectName: "inbound",
          environment: "production",
        },
      },
    });
    expect(captureVercel).toHaveBeenCalledWith(
      ["api", "/v13/deployments/inbound.example.com", "--raw"],
      expect.objectContaining({ cwd: "/repo", nonInteractive: true, timeoutMs: 10_000 }),
    );
  });

  it("scopes the lookup and cross-checks the project when a source is provided", async () => {
    const captureVercel = vi.fn<VercelDeploymentResolutionDeps["captureVercel"]>(async () => ({
      ok: true,
      stdout: JSON.stringify(STANDARD),
    }));

    await expect(
      resolveVercelDeployment({
        workspaceRoot: "/repo",
        host: "inbound.example.com",
        source: { orgId: "team_a", projectId: "prj_target" },
        deps: { captureVercel },
      }),
    ).resolves.toMatchObject({
      kind: "resolved",
      target: { deployment: { ownerId: "team_a", projectId: "prj_target" } },
    });
    expect(captureVercel).toHaveBeenCalledWith(
      ["api", "/v13/deployments/inbound.example.com", "--scope", "team_a", "--raw"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("scopes the lookup to a selected team without requiring a project", async () => {
    const captureVercel = vi.fn<VercelDeploymentResolutionDeps["captureVercel"]>(async () => ({
      ok: true,
      stdout: JSON.stringify(STANDARD),
    }));

    await expect(
      resolveVercelDeployment({
        workspaceRoot: "/repo",
        host: "inbound.example.com",
        scope: "team_a",
        deps: { captureVercel },
      }),
    ).resolves.toMatchObject({
      kind: "resolved",
      target: { deployment: { ownerId: "team_a", projectId: "prj_target" } },
    });
    expect(captureVercel).toHaveBeenCalledWith(
      ["api", "/v13/deployments/inbound.example.com", "--scope", "team_a", "--raw"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("derives the canonical owner id from the response, not the queried scope", async () => {
    const captureVercel = vi.fn<VercelDeploymentResolutionDeps["captureVercel"]>(async () => ({
      ok: true,
      stdout: JSON.stringify({ ...STANDARD, ownerId: "team_acme" }),
    }));

    const resolution = await resolveVercelDeployment({
      workspaceRoot: "/repo",
      host: "inbound.example.com",
      // The caller may scope with a team slug, but the OIDC owner_id claim is
      // the canonical team_* id; the target must carry the id Vercel returned.
      source: { orgId: "acme", projectId: "prj_target" },
      deps: { captureVercel },
    });

    expect(resolution).toMatchObject({
      kind: "resolved",
      target: { deployment: { ownerId: "team_acme", projectId: "prj_target" } },
    });
    expect(captureVercel).toHaveBeenCalledWith(
      ["api", "/v13/deployments/inbound.example.com", "--scope", "acme", "--raw"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("reports a denied scope as forbidden so the caller can re-authenticate", async () => {
    const captureVercel = vi.fn<VercelDeploymentResolutionDeps["captureVercel"]>(async () => ({
      ok: false,
      failure: {
        code: 1,
        stdout: JSON.stringify({ error: { code: "forbidden", message: "SSO required" } }),
        stderr: "",
        message: "vercel api /v13/deployments/inbound.example.com exited with code 1.",
      },
    }));

    await expect(
      resolveVercelDeployment({
        workspaceRoot: "/repo",
        host: "inbound.example.com",
        deps: { captureVercel },
      }),
    ).resolves.toEqual({ kind: "forbidden" });
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
            stdout: JSON.stringify({ ...STANDARD, projectId: "prj_other", name: "other" }),
          }),
        },
      }),
    ).resolves.toEqual({
      kind: "project-mismatch",
      expectedProjectId: "prj_source",
      actualProjectId: "prj_other",
    });
  });

  it("distinguishes not-found, operational, and invalid-response failures", async () => {
    const captures: VercelCaptureResult[] = [
      {
        ok: true,
        stdout: JSON.stringify({ error: { code: "not_found", message: "missing" } }),
      },
      {
        ok: false,
        failure: { code: null, stdout: "", stderr: "", message: "vercel api timed out." },
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
              stdout: JSON.stringify({ error: { code: "internal", message: "boom" } }),
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
