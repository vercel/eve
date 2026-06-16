import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveDevelopmentOidcToken } from "#services/dev-client/request-headers.js";

import { resolveEvalClientOptions } from "./eval-client.js";

describe("resolveEvalClientOptions", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses a bare client for local targets", () => {
    const options = resolveEvalClientOptions({ kind: "local", url: "http://127.0.0.1:3000" });
    expect(options).toEqual({ host: "http://127.0.0.1:3000" });
  });

  it("resolves dev-client headers and the OIDC bearer for remote targets", () => {
    const options = resolveEvalClientOptions({
      kind: "remote",
      url: "https://example.vercel.app",
    });
    expect(options.host).toBe("https://example.vercel.app");
    expect(options.preserveCompletedSessions).toBe(false);
    // The per-request resolver attaches the trusted OIDC IDP token (Deployment
    // Protection bypass) and any VERCEL_AUTOMATION_BYPASS_SECRET header.
    expect(typeof options.headers).toBe("function");
    expect(options.auth).toEqual({ bearer: resolveDevelopmentOidcToken });
  });

  it("prefers the EVE_EVAL_AUTH_TOKEN static bearer override", () => {
    vi.stubEnv("EVE_EVAL_AUTH_TOKEN", "static-token");
    const options = resolveEvalClientOptions({
      kind: "remote",
      url: "https://example.vercel.app",
    });
    expect(options.auth).toEqual({ bearer: "static-token" });
    expect(typeof options.headers).toBe("function");
  });

  it("ignores a blank EVE_EVAL_AUTH_TOKEN", () => {
    vi.stubEnv("EVE_EVAL_AUTH_TOKEN", "   ");
    const options = resolveEvalClientOptions({
      kind: "remote",
      url: "https://example.vercel.app",
    });
    expect(options.auth).toEqual({ bearer: resolveDevelopmentOidcToken });
  });
});
