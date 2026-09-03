import { describe, expect, it } from "vitest";

import {
  buildSlackAppManifests,
  buildVercelConnectRequirements,
  createVercelConnectManifest,
  slackAppManifestPath,
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
        providerConfiguration: {
          format: "slack-app-manifest",
          path: "channels/slack.slack-app-manifest.json",
        },
        triggers: [{ method: "POST", path: "/eve/v1/slack" }],
        uses: [{ kind: "channel", name: "slack", logicalPath: "channels/slack.ts" }],
      },
    ]);
  });

  it("derives separate Slack manifest paths from channel source paths", () => {
    expect(slackAppManifestPath("channels/slack.ts")).toBe(
      "channels/slack.slack-app-manifest.json",
    );
    expect(slackAppManifestPath("channels/support/slack.tsx")).toBe(
      "channels/support/slack.slack-app-manifest.json",
    );
  });

  it("builds a Slack-native app manifest for channels without Connect metadata", () => {
    const manifests = buildSlackAppManifests({
      channelRoutes: {
        effective: [
          {
            adapterKind: "slack",
            name: "support",
            logicalPath: "channels/support.ts",
            slackAppManifest: {
              alwaysOnline: true,
              backgroundColor: "#000000",
              botEvents: ["app_mention", "message.channels"],
              botScopes: ["chat:write", "channels:history"],
              description: "Answers support questions.",
              displayName: "Support agent",
              longDescription: "Answers support questions using the team's knowledge base.",
            },
          },
          {
            adapterKind: "slack",
            name: "portable",
            logicalPath: "channels/portable.ts",
          },
        ],
      },
    } as const);

    expect(Object.fromEntries(manifests)).toEqual({
      "channels/support.slack-app-manifest.json": {
        display_information: {
          background_color: "#000000",
          description: "Answers support questions.",
          long_description: "Answers support questions using the team's knowledge base.",
          name: "Support agent",
        },
        features: {
          app_home: {
            home_tab_enabled: false,
            messages_tab_enabled: true,
            messages_tab_read_only_enabled: false,
          },
          bot_user: { display_name: "Support agent", always_online: true },
        },
        oauth_config: {
          scopes: { bot: ["app_mentions:read", "chat:write", "channels:history"] },
        },
        settings: {
          event_subscriptions: { bot_events: ["app_mention", "message.channels"] },
          interactivity: { is_enabled: true },
          org_deploy_enabled: false,
          socket_mode_enabled: false,
          token_rotation_enabled: false,
        },
      },
      "channels/portable.slack-app-manifest.json": expect.any(Object),
    });
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
