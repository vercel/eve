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

const rfc7591Manifest = { $type: "https://datatracker.ietf.org/doc/html/rfc7591" };

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
        manifest: rfc7591Manifest,
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
  it.each(["app", "user"] as const)("emits a direct %s OAuth connection", (subjectType) => {
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
            principalTypes: [subjectType],
          },
        },
      ],
      channelRoutes: { effective: [] },
    } as const;

    expect(buildVercelConnectRequirements(manifest)).toEqual([
      {
        target: "connector:oauth/linear",
        interfaces: [{ protocol: "mcp", url: "https://mcp.linear.app/mcp" }],
        connect: {
          subjectTypes: [subjectType],
          service: "linear",
          type: "oauth",
          manifest: rfc7591Manifest,
        },
        uses: [use],
      },
    ]);
  });

  it("embeds a Connect-managed Slack app manifest", () => {
    const slackAppManifest = {
      display_information: { name: "slack" },
      oauth_config: { scopes: { bot: ["chat:write"] } },
      settings: {
        event_subscriptions: { bot_events: ["app_mention"] },
        interactivity: { is_enabled: true },
      },
    } as const;
    const manifest = {
      connections: [],
      channelRoutes: {
        effective: [
          {
            adapterKind: "slack",
            name: "slack",
            logicalPath: "channels/slack.ts",
            slackAppManifest,
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
          manifest: {
            $type: "https://docs.slack.dev/reference/app-manifest/",
            display_information: { name: "slack" },
            oauth_config: {
              redirect_urls: ["https://connect.vercel.com/callback"],
              scopes: { bot: ["chat:write"] },
            },
            settings: {
              event_subscriptions: {
                bot_events: ["app_mention"],
                request_url: "https://connect.vercel.com/trigger?path=/eve/v1/slack",
              },
              interactivity: {
                is_enabled: true,
                request_url: "https://connect.vercel.com/trigger?path=/eve/v1/slack",
              },
            },
          },
        },
        uses: [{ kind: "channel", name: "slack", logicalPath: "channels/slack.ts" }],
      },
    ]);
    expect(slackAppManifest).not.toHaveProperty("$type");
    expect(slackAppManifest.oauth_config).not.toHaveProperty("redirect_urls");
  });

  it.each([
    { adapterKind: "custom", slackAppManifest: { display_information: { name: "custom" } } },
    { adapterKind: "slack", slackAppManifest: undefined },
  ])("does not emit an incomplete Slack requirement", ({ adapterKind, slackAppManifest }) => {
    const manifest = {
      connections: [],
      channelRoutes: {
        effective: [
          {
            adapterKind,
            name: "custom",
            logicalPath: "channels/custom.ts",
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

    expect(buildVercelConnectRequirements(manifest)).toEqual([]);
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
