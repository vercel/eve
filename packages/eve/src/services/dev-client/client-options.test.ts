import { describe, expect, it } from "vitest";

import {
  resolveDevelopmentClientOptions,
  resolveRemoteDevelopmentClientOptions,
} from "./client-options.js";
import { createDevelopmentCredentialGate } from "./credential-gate.js";
import { isLocalDevelopmentServerUrl } from "./local-host.js";

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
});
