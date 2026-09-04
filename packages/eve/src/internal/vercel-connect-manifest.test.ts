import { describe, expect, it } from "vitest";

import {
  createVercelConnectManifest,
  type VercelConnectRequirement,
} from "#internal/vercel-connect-manifest.js";

const use = {
  kind: "connection" as const,
  name: "linear",
  logicalPath: "connections/linear.ts",
};

describe("createVercelConnectManifest", () => {
  it("omits an empty manifest", () => {
    expect(
      createVercelConnectManifest({ generatorVersion: "1.2.3", requirements: [] }),
    ).toBeUndefined();
  });

  it.each<VercelConnectRequirement>([
    {
      target: { mode: "direct", locator: "oauth/linear" },
      connector: { type: "oauth" },
      access: { principalTypes: ["user"] },
      uses: [use],
    },
    {
      target: { mode: "binding", reference: "connections/linear" },
      connector: { type: "oauth", configuration: { service: "mcp.linear.app" } },
      providerConfiguration: {
        format: "slack-app-manifest",
        path: "channels/support.slack-app-manifest.json",
      },
      access: { principalTypes: ["user"] },
      uses: [use],
    },
  ])("preserves the $target.mode target shape", (requirement) => {
    expect(
      createVercelConnectManifest({ generatorVersion: "1.2.3", requirements: [requirement] }),
    ).toEqual({
      kind: "vercel-connect-manifest",
      schemaVersion: 1,
      generator: { name: "eve", version: "1.2.3" },
      requirements: [requirement],
    });
  });
});
