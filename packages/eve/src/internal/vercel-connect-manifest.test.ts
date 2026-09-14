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
            connector: "connector:oauth/linear",
            connectorType: "oauth",
            principalTypes: [principalType],
          },
        },
      ],
      channelRoutes: { effective: [] },
    } as const;

    expect(buildVercelConnectRequirements(manifest)).toEqual([
      {
        target: "connector:oauth/linear",
        connector: { type: "oauth" },
        interface: { protocol: "mcp", url: "https://mcp.linear.app/mcp" },
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
            adapterKind: "slack",
            name: "slack",
            logicalPath: "channels/slack.ts",
            method: "POST",
            slackAppManifest: { display_information: { name: "slack" } },
            urlPath: "/eve/v1/slack",
            vercelConnect: {
              connector: "connector:slack/my-agent",
              connectorType: "slack",
              principalTypes: ["app"],
            },
          },
        ],
      },
    } as const;

    expect(buildVercelConnectRequirements(manifest)).toEqual([
      {
        target: "connector:slack/my-agent",
        connector: { type: "slack" },
        access: { principalTypes: ["app"] },
        providerConfiguration: {
          format: "slack-app-manifest",
          path: "channels/slack.slack-app-manifest.json",
        },
        trigger: { method: "POST", path: "/eve/v1/slack" },
        uses: [{ kind: "channel", name: "slack", logicalPath: "channels/slack.ts" }],
      },
    ]);
  });

  it.each([
    { adapterKind: "custom", slackAppManifest: { display_information: { name: "custom" } } },
    { adapterKind: "slack", slackAppManifest: undefined },
  ])("does not reference a missing Slack app manifest", ({ adapterKind, slackAppManifest }) => {
    const manifest = {
      connections: [],
      channelRoutes: {
        effective: [
          {
            adapterKind,
            name: "custom",
            logicalPath: "channels/custom.ts",
            method: "POST",
            slackAppManifest,
            urlPath: "/custom",
            vercelConnect: {
              connector: "connector:slack/custom",
              connectorType: "slack",
              principalTypes: ["app"],
            },
          },
        ],
      },
    } as const;

    expect(buildVercelConnectRequirements(manifest)).toEqual([
      {
        target: "connector:slack/custom",
        connector: { type: "slack" },
        access: { principalTypes: ["app"] },
        trigger: { method: "POST", path: "/custom" },
        uses: [{ kind: "channel", name: "custom", logicalPath: "channels/custom.ts" }],
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
