import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveTestVercelTarget } from "#internal/testing/verified-vercel-target.js";

import { createEvalClient, resolveEvalClientOptions } from "./eval-client.js";

const VERIFIED_TARGET = await resolveTestVercelTarget({
  host: "example.vercel.app",
  projectId: "prj_example",
  projectName: "example",
});

describe("resolveEvalClientOptions", () => {
  afterEach(() => {
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
    expect(options.preserveCompletedSessions).toBe(false);
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

  it("authorizes ambient OIDC only after Vercel verifies the exact remote origin", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ok: true, status: "ready", workflowId: "wf" }));
    const resolveDevelopmentOidcToken = vi.fn(async () => "verified-token");
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

    await client.health();

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer verified-token");
    expect(headers.get("x-vercel-trusted-oidc-idp-token")).toBe("verified-token");
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("does not resolve or emit ambient OIDC for an unverified remote origin", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ok: true, status: "ready", workflowId: "wf" }));
    const resolveDevelopmentOidcToken = vi.fn(async () => "ambient-token");
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
