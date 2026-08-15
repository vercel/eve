import { describe, expect, it } from "vitest";

import { integrationSetupEnvironment, describeIntegrationSetupEnvironment } from "./environment.js";

describe("channel setup environment", () => {
  it("keeps authenticated and unlinked as an available Vercel setup", () => {
    const environment = integrationSetupEnvironment("authenticated", { kind: "unresolved" });
    expect(environment).toEqual({
      vercel: { kind: "available", project: { kind: "unresolved" } },
    });
    expect(describeIntegrationSetupEnvironment(environment)).toBe(
      "Found an authenticated Vercel account; this directory is not linked to a project.",
    );
  });

  it("reports the credential choice when logged out", () => {
    const environment = integrationSetupEnvironment("logged-out", { kind: "unresolved" });
    expect(environment).toEqual({ vercel: { kind: "unavailable", reason: "logged-out" } });
    expect(describeIntegrationSetupEnvironment(environment)).toBe(
      "No authenticated Vercel account found; choose Vercel Connect or portable credentials.",
    );
  });
});
