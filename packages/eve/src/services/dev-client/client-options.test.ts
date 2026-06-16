import { describe, expect, it } from "vitest";

import { resolveDevelopmentOidcToken } from "./request-headers.js";

import { resolveDevelopmentClientOptions } from "./client-options.js";

describe("resolveDevelopmentClientOptions", () => {
  it("targets the given host and resolves headers lazily", () => {
    const options = resolveDevelopmentClientOptions("http://localhost:3000");
    expect(options.host).toBe("http://localhost:3000");
    expect(typeof options.headers).toBe("function");
  });

  it("does not preserve completed sessions across dev prompts", () => {
    expect(resolveDevelopmentClientOptions("http://localhost:3000").preserveCompletedSessions).toBe(
      undefined,
    );
  });

  it("skips the OIDC bearer for local hosts", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      expect(resolveDevelopmentClientOptions(url).auth).toBeUndefined();
    }
  });

  it("attaches the dev OIDC bearer for remote hosts", () => {
    const options = resolveDevelopmentClientOptions("https://example.com");
    expect(options.auth).toEqual({ bearer: resolveDevelopmentOidcToken });
  });
});
