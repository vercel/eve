import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveTestVercelTarget } from "#internal/testing/verified-vercel-target.js";
import type { DevelopmentOidcTokenResolution } from "#services/dev-client/request-headers.js";
import {
  resolveVercelDeployment,
  type VercelDeploymentResolutionDeps,
} from "#setup/vercel-deployment.js";

import { createEvalClient, resolveEvalClientOptions } from "./eval-client.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: vi.fn(),
}));

const VERIFIED_TARGET = await resolveTestVercelTarget({
  host: "example.vercel.app",
  projectId: "prj_example",
  projectName: "example",
});

describe("resolveEvalClientOptions", () => {
  beforeEach(() => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
  });

  afterEach(() => {
    vi.mocked(readFile).mockReset();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("uses a bare client for local targets", () => {
    const options = resolveEvalClientOptions({ kind: "local", url: "http://127.0.0.1:3000" });
    expect(options).toEqual({ host: "http://127.0.0.1:3000" });
  });

  it("keeps the synchronous remote options anonymous", () => {
    const options = resolveEvalClientOptions({
      kind: "remote",
      url: "https://example.vercel.app",
    });
    expect(options.host).toBe("https://example.vercel.app");
    expect(options.headers).toBeUndefined();
    expect(options.auth).toBeUndefined();
  });

  it("prefers the EVE_EVAL_AUTH_TOKEN static bearer override", () => {
    vi.stubEnv("EVE_EVAL_AUTH_TOKEN", "static-token");
    const options = resolveEvalClientOptions({
      kind: "remote",
      url: "https://example.vercel.app",
    });
    expect(options.auth).toEqual({ bearer: "static-token" });
    expect(options.redirect).toBe("manual");
    expect(options.headers).toBeUndefined();
  });

  it("ignores a blank EVE_EVAL_AUTH_TOKEN", () => {
    vi.stubEnv("EVE_EVAL_AUTH_TOKEN", "   ");
    const options = resolveEvalClientOptions({
      kind: "remote",
      url: "https://example.vercel.app",
    });
    expect(options.auth).toBeUndefined();
  });

  it("resolves ambient OIDC per request after Vercel verifies the exact remote origin", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: true, status: "ready", workflowId: "wf" }))
      .mockResolvedValueOnce(Response.json({ ok: true, status: "ready", workflowId: "wf" }));
    const resolveDevelopmentOidcToken = vi
      .fn<
        (input: {
          readonly ownerId: string;
          readonly projectId: string;
        }) => Promise<DevelopmentOidcTokenResolution>
      >()
      .mockResolvedValueOnce({ kind: "resolved", token: " first-token " })
      .mockResolvedValueOnce({ kind: "resolved", token: "second-token" });
    const client = await createEvalClient(
      { kind: "remote", url: "https://example.vercel.app" },
      {
        workspaceRoot: "/workspace",
        deps: {
          resolveVercelDeployment: async () => ({
            kind: "resolved",
            target: VERIFIED_TARGET,
          }),
          resolveDevelopmentOidcToken,
        },
      },
    );

    expect(resolveDevelopmentOidcToken).not.toHaveBeenCalled();
    await client.health();
    await client.health();

    const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.get("authorization")).toBe("Bearer first-token");
    expect(firstHeaders.get("x-vercel-trusted-oidc-idp-token")).toBe("first-token");
    expect(secondHeaders.get("authorization")).toBe("Bearer second-token");
    expect(secondHeaders.get("x-vercel-trusted-oidc-idp-token")).toBe("second-token");
    expect(resolveDevelopmentOidcToken).toHaveBeenCalledTimes(2);
    expect(resolveDevelopmentOidcToken).toHaveBeenNthCalledWith(1, {
      ownerId: "team_test",
      projectId: "prj_example",
    });
    expect(resolveDevelopmentOidcToken).toHaveBeenNthCalledWith(2, {
      ownerId: "team_test",
      projectId: "prj_example",
    });
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(fetchMock.mock.calls[1]?.[1]?.redirect).toBe("manual");
  });

  it("does not resolve or emit ambient OIDC for an unverified remote origin", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ok: true, status: "ready", workflowId: "wf" }));
    const resolveDevelopmentOidcToken = vi.fn(async () => ({
      kind: "resolved" as const,
      token: "ambient-token",
    }));
    const client = await createEvalClient(
      { kind: "remote", url: "https://arbitrary.example.com" },
      {
        workspaceRoot: "/workspace",
        deps: {
          resolveVercelDeployment: async () => ({ kind: "not-found" }),
          resolveDevelopmentOidcToken,
        },
      },
    );

    await client.health();

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(resolveDevelopmentOidcToken).not.toHaveBeenCalled();
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-vercel-trusted-oidc-idp-token")).toBeNull();
  });
});

describe("remote eval project verification", () => {
  const captureVercel = vi.fn<VercelDeploymentResolutionDeps["captureVercel"]>();
  const resolveDevelopmentOidcToken = vi.fn(async () => ({
    kind: "resolved" as const,
    token: "ambient-token",
  }));
  const deployment = {
    ownerId: "team_b",
    projectId: "prj_target",
    name: "target",
    target: "preview",
  };

  beforeEach(() => {
    vi.stubEnv("EVE_EVAL_AUTH_TOKEN", "");
    vi.stubEnv("VERCEL_ORG_ID", "");
    vi.stubEnv("VERCEL_PROJECT_ID", "");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "bypass-secret");
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ orgId: "team_b", projectId: "prj_target" }),
    );
    captureVercel.mockResolvedValue({ ok: true, stdout: JSON.stringify(deployment) });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: true, status: "ready", workflowId: "wf" }),
    );
  });

  afterEach(() => {
    captureVercel.mockReset();
    resolveDevelopmentOidcToken.mockClear();
    vi.mocked(readFile).mockReset();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function createRemoteClient() {
    return createEvalClient(
      { kind: "remote", url: "https://target.vercel.app" },
      {
        workspaceRoot: "/workspace",
        deps: {
          resolveVercelDeployment: (input) =>
            resolveVercelDeployment({ ...input, deps: { captureVercel } }),
          resolveDevelopmentOidcToken,
        },
      },
    );
  }

  it.each([
    { source: "the complete environment pair", orgId: " team_b ", projectId: " prj_target " },
    { source: "the project link", orgId: "", projectId: "" },
    {
      source: "the project link with an incomplete environment pair",
      orgId: "team_a",
      projectId: "",
    },
    {
      source: "the project link with a blank environment value",
      orgId: " ",
      projectId: "prj_other",
    },
  ])("authenticates across CLI teams using $source", async ({ orgId, projectId }) => {
    vi.stubEnv("VERCEL_ORG_ID", orgId);
    vi.stubEnv("VERCEL_PROJECT_ID", projectId);
    if (orgId.trim() && projectId.trim()) {
      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({ orgId: "team_a", projectId: "prj_other" }),
      );
    }
    captureVercel.mockImplementation(async (args) => {
      if (args[args.indexOf("--scope") + 1] !== "team_b") {
        return {
          ok: false,
          failure: {
            code: 1,
            stdout: "",
            stderr: "Error: Deployment not found (404)",
            message: "Deployment lookup failed.",
          },
        };
      }
      return { ok: true, stdout: JSON.stringify(deployment) };
    });

    const client = await createRemoteClient();
    await client.health();

    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    const headers = new Headers(request?.headers);
    expect(headers.get("authorization")).toBe("Bearer ambient-token");
    expect(headers.get("x-vercel-trusted-oidc-idp-token")).toBe("ambient-token");
    expect(headers.get("x-vercel-protection-bypass")).toBe("bypass-secret");
    expect(request?.redirect).toBe("manual");
    expect(resolveDevelopmentOidcToken).toHaveBeenCalledWith({
      ownerId: "team_b",
      projectId: "prj_target",
    });
  });

  it("withholds ambient credentials when the deployment belongs to another linked project", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ orgId: "team_b", projectId: "prj_other" }),
    );

    const client = await createRemoteClient();
    await client.health();

    const headers = new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-vercel-trusted-oidc-idp-token")).toBeNull();
    expect(headers.get("x-vercel-protection-bypass")).toBeNull();
    expect(resolveDevelopmentOidcToken).not.toHaveBeenCalled();
  });

  it("uses an explicit bearer without resolving a Vercel project", async () => {
    vi.stubEnv("EVE_EVAL_AUTH_TOKEN", "static-token");

    const client = await createRemoteClient();
    await client.health();

    const headers = new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer static-token");
    expect(headers.get("x-vercel-trusted-oidc-idp-token")).toBeNull();
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(captureVercel).not.toHaveBeenCalled();
    expect(resolveDevelopmentOidcToken).not.toHaveBeenCalled();
  });
});
