import { afterEach, describe, expect, it, vi } from "vitest";

import { Client } from "#client/client.js";
import {
  resolveDevelopmentClientOptions,
  resolveLocalDevelopmentClientOptions,
  resolveRemoteDevelopmentClientOptions,
} from "./client-options.js";
import type { DevelopmentCredentialGate } from "./credential-gate.js";
import { createDevelopmentCredentialGate } from "./credential-gate.js";
import { isLocalDevelopmentServerUrl } from "./local-host.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveDevelopmentClientOptions", () => {
  it("targets the given host without inferring credentials from locality", () => {
    const options = resolveDevelopmentClientOptions("http://localhost:3000");
    expect(options.host).toBe("http://localhost:3000");
    expect(options.auth).toBeUndefined();
    expect(options.headers).toBeUndefined();

    const remote = resolveDevelopmentClientOptions("https://arbitrary.example.com");
    expect(remote.auth).toBeUndefined();
    expect(remote.headers).toBeUndefined();
  });

  it("does not preserve completed sessions across dev prompts", () => {
    expect(resolveDevelopmentClientOptions("http://localhost:3000").preserveCompletedSessions).toBe(
      undefined,
    );
  });

  it("skips the OIDC bearer for local hosts", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      expect(isLocalDevelopmentServerUrl(url)).toBe(true);
      expect(resolveDevelopmentClientOptions(url).auth).toBeUndefined();
    }
  });

  it("uses an explicit per-request bearer for the local TUI server", () => {
    const token = vi.fn(async () => "user-oidc-token");

    const options = resolveLocalDevelopmentClientOptions({
      serverUrl: "http://127.0.0.1:3000",
      token,
    });

    expect(options).toMatchObject({
      auth: { bearer: token },
      host: "http://127.0.0.1:3000",
      redirect: "manual",
    });
  });

  it("does not override explicit local authorization with the linked Vercel bearer", async () => {
    const token = vi.fn(async () => "user-oidc-token");

    const options = resolveLocalDevelopmentClientOptions({
      headers: {
        Authorization: "Basic dGVzdDpzZWNyZXQ=",
        "x-tenant": "acme",
      },
      serverUrl: "http://127.0.0.1:3000",
      token,
    });

    expect(options.auth).toBeUndefined();

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    await new Client(options).fetch("/eve/v1/info");

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Basic dGVzdDpzZWNyZXQ=");
    expect(headers.get("x-tenant")).toBe("acme");
    expect(token).not.toHaveBeenCalled();
  });

  it("keeps the linked Vercel bearer for local headers without authorization", async () => {
    const token = vi.fn(async () => "user-oidc-token");

    const options = resolveLocalDevelopmentClientOptions({
      headers: { "x-tenant": "acme" },
      serverUrl: "http://127.0.0.1:3000",
      token,
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    await new Client(options).fetch("/eve/v1/info");

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer user-oidc-token");
    expect(headers.get("x-tenant")).toBe("acme");
    expect(token).toHaveBeenCalledTimes(1);
  });

  it("binds an authorized credential gate to a non-redirecting client", () => {
    const credentials = createDevelopmentCredentialGate("https://verified.example.com");

    const options = resolveRemoteDevelopmentClientOptions({
      credentials,
      serverUrl: "https://verified.example.com",
    });

    expect(options.host).toBe("https://verified.example.com");
    expect(options.redirect).toBe("manual");
    expect(options.headers).toBe(credentials.resolveBypassHeaders);
    // The token flows through the higher-level vercelOidc auth, never headers.
    expect(options.auth).toEqual({ vercelOidc: { token: expect.any(Function) } });
  });

  it("keeps explicit remote authorization while adding Vercel bypass and trusted headers", async () => {
    const credentials = {
      authorize: vi.fn(() => () => {}),
      lastTokenFailure: vi.fn(() => undefined),
      resolveBypassHeaders: vi.fn(async () => ({
        "x-explicit": "from-bypass",
        "x-vercel-protection-bypass": "from-env",
      })),
      resolveToken: vi.fn(async () => "oidc-token"),
      serverOrigin: "https://verified.example.com",
    } satisfies DevelopmentCredentialGate;

    const options = resolveRemoteDevelopmentClientOptions({
      credentials,
      headers: {
        authorization: "Basic dGVzdDpzZWNyZXQ=",
        "x-explicit": "from-cli",
      },
      serverUrl: "https://verified.example.com",
    });

    expect(options.auth).toBeUndefined();
    if (typeof options.headers !== "function") {
      throw new Error("Expected dynamic headers.");
    }

    await expect(options.headers()).resolves.toEqual({
      authorization: "Basic dGVzdDpzZWNyZXQ=",
      "x-explicit": "from-cli",
      "x-vercel-protection-bypass": "from-env",
      "x-vercel-trusted-oidc-idp-token": "oidc-token",
    });
  });
});
