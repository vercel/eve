import { describe, expect, it, vi } from "vitest";

import {
  checkDeployEnvironment,
  type DeployEnvironmentCheckDeps,
} from "./deploy-environment-check.js";

function createDeps(
  local: Readonly<Record<string, string | null>>,
  remote: unknown = { envs: [] },
): DeployEnvironmentCheckDeps {
  return {
    readLocalEnvironment: vi.fn(() => local),
    captureVercel: vi.fn<DeployEnvironmentCheckDeps["captureVercel"]>(async () => ({
      ok: true,
      stdout: JSON.stringify(remote),
    })),
  };
}

describe("checkDeployEnvironment", () => {
  it("returns sorted local keys missing from Vercel Production", async () => {
    const deps = createDeps(
      { ZEBRA_TOKEN: "zebra", OPENAI_API_KEY: "openai", SHARED_KEY: "shared" },
      { envs: [{ key: "SHARED_KEY", target: ["production"] }] },
    );

    await expect(checkDeployEnvironment("/tmp/project", { deps })).resolves.toEqual({
      checked: true,
      missing: ["OPENAI_API_KEY", "ZEBRA_TOKEN"],
    });
    expect(deps.captureVercel).toHaveBeenCalledWith(
      ["env", "list", "production", "--json"],
      expect.objectContaining({ cwd: "/tmp/project", nonInteractive: true }),
    );
  });

  it("does not count branch-scoped variables as available to every production deploy", async () => {
    const deps = createDeps(
      { OPENAI_API_KEY: "openai" },
      { envs: [{ key: "OPENAI_API_KEY", target: ["production"], gitBranch: "main" }] },
    );

    await expect(checkDeployEnvironment("/tmp/project", { deps })).resolves.toEqual({
      checked: true,
      missing: ["OPENAI_API_KEY"],
    });
  });

  it("ignores Vercel-provided and local runtime variables", async () => {
    const deps = createDeps({ NODE_ENV: "development", VERCEL_OIDC_TOKEN: "token" });

    await expect(checkDeployEnvironment("/tmp/project", { deps })).resolves.toEqual({
      checked: true,
      missing: [],
    });
    expect(deps.captureVercel).not.toHaveBeenCalled();
  });

  it("does not report missing variables when the Vercel lookup fails", async () => {
    const deps = createDeps({ OPENAI_API_KEY: "openai" });
    vi.mocked(deps.captureVercel).mockResolvedValue({
      ok: false,
      failure: { message: "failed", stderr: "", stdout: "" },
    });

    await expect(checkDeployEnvironment("/tmp/project", { deps })).resolves.toEqual({
      checked: false,
      missing: [],
    });
  });

  it("does not expose local values to the Vercel lookup", async () => {
    const deps = createDeps({ PRIVATE_KEY: "do-not-print" });

    await checkDeployEnvironment("/tmp/project", { deps });

    expect(JSON.stringify(vi.mocked(deps.captureVercel).mock.calls)).not.toContain("do-not-print");
  });
});
