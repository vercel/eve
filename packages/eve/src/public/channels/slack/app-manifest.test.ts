import { describe, expect, it } from "vitest";

import { defineSlackAppManifest } from "#public/channels/slack/app-manifest.js";

describe("Slack app manifests", () => {
  it("builds the native baseline manifest", () => {
    expect(defineSlackAppManifest({}).build("support")).toEqual({
      $type: "https://docs.slack.dev/reference/app-manifest/",
      display_information: { name: "support" },
      features: {
        app_home: {
          home_tab_enabled: false,
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
        bot_user: { display_name: "support" },
      },
      oauth_config: { scopes: { bot: ["app_mentions:read", "chat:write"] } },
      settings: {
        event_subscriptions: { bot_events: ["app_mention"] },
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    });
  });

  it("uses a configured bot name and enforces Slack's app name limit", () => {
    const definition = defineSlackAppManifest({ botName: "x".repeat(40) });

    expect(definition.build("support")).toMatchObject({
      display_information: { name: "x".repeat(35) },
      features: { bot_user: { display_name: "x".repeat(35) } },
    });
  });
});
