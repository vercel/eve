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
      target: "connector:oauth/linear",
      interfaces: [{ protocol: "mcp", url: "https://mcp.linear.app/mcp" }],
      connect: {
        subjectTypes: ["user"],
        service: "linear",
        type: "oauth",
        manifest: { $type: "https://datatracker.ietf.org/doc/html/rfc7591" },
      },
      uses: [use],
    },
    {
      target: "connector:slack/support",
      interfaces: [
        {
          protocol: "custom",
          url: "https://docs.slack.dev/apis/web-api/",
          npm: "@slack/web-api",
        },
      ],
      connect: {
        subjectTypes: ["app"],
        service: "slack",
        type: "slack",
        manifest: { $type: "https://docs.slack.dev/reference/app-manifest/" },
      },
      uses: [use],
    },
  ])("preserves the opaque target reference", (requirement) => {
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
