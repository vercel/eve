import { describe, expect, it } from "vitest";

import {
  buildVercelConnectRequirements,
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

describe("buildVercelConnectRequirements", () => {
  it.each(["app", "user"] as const)("emits a direct %s OAuth connection", (principalType) => {
    const manifest = {
      connections: [
        {
          connectionName: "linear",
          logicalPath: "connections/linear.ts",
          protocol: "mcp",
          url: "https://mcp.linear.app/mcp",
          vercelConnect: {
            connector: "oauth/linear",
            connectorType: "oauth",
            principalTypes: [principalType],
          },
        },
      ],
      channelRoutes: { effective: [] },
    } as const;

    expect(buildVercelConnectRequirements(manifest)).toEqual([
      {
        target: { mode: "direct", locator: "oauth/linear" },
        connector: { type: "oauth" },
        resource: { protocol: "mcp", url: "https://mcp.linear.app/mcp" },
        access: { principalTypes: [principalType] },
        uses: [use],
      },
    ]);
  });

  it("emits a Slack requirement with its trigger route", () => {
    const manifest = {
      connections: [],
      channelRoutes: {
        effective: [
          {
            name: "slack",
            logicalPath: "channels/slack.ts",
            method: "POST",
            urlPath: "/eve/v1/slack",
            vercelConnect: {
              connector: "slack/my-agent",
              connectorType: "slack",
              principalTypes: ["app"],
            },
          },
        ],
      },
    } as const;

    expect(buildVercelConnectRequirements(manifest)).toEqual([
      {
        target: { mode: "direct", locator: "slack/my-agent" },
        connector: { type: "slack" },
        access: { principalTypes: ["app"] },
        triggers: [{ method: "POST", path: "/eve/v1/slack" }],
        uses: [{ kind: "channel", name: "slack", logicalPath: "channels/slack.ts" }],
      },
    ]);
  });

  it("ignores connections without Connect metadata", () => {
    const manifest = {
      connections: [
        {
          connectionName: "linear",
          logicalPath: "connections/linear.ts",
          protocol: "mcp",
          url: "https://mcp.linear.app/mcp",
        },
      ],
      channelRoutes: { effective: [] },
    } as const;

    expect(buildVercelConnectRequirements(manifest)).toEqual([]);
  });
});
