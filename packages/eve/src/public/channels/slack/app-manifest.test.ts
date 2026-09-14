import { describe, expect, it } from "vitest";

import {
  buildSlackAppManifest,
  defineSlackAppManifest,
} from "#public/channels/slack/app-manifest.js";

describe("Slack app manifests", () => {
  it("builds the native baseline manifest", () => {
    expect(buildSlackAppManifest(defineSlackAppManifest({}), "support")).toEqual({
      display_information: { name: "support" },
      features: {
        app_home: {
          home_tab_enabled: false,
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
        bot_user: { display_name: "support", always_online: false },
      },
      oauth_config: { scopes: { bot: ["app_mentions:read", "chat:write"] } },
      settings: {
        event_subscriptions: { bot_events: ["app_mention"] },
        interactivity: { is_enabled: true },
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    });
  });

  it("adds an explicitly configured request URL", () => {
    const definition = defineSlackAppManifest({
      requestUrl: "https://agent.example.com/eve/v1/slack",
    });

    expect(buildSlackAppManifest(definition, "support")).toMatchObject({
      settings: {
        event_subscriptions: {
          request_url: "https://agent.example.com/eve/v1/slack",
        },
        interactivity: {
          request_url: "https://agent.example.com/eve/v1/slack",
        },
      },
    });
  });

  it("uses a configured bot name and enforces Slack's app name limit", () => {
    const definition = defineSlackAppManifest({ displayName: "x".repeat(40) });

    expect(buildSlackAppManifest(definition, "support")).toMatchObject({
      display_information: { name: "x".repeat(35) },
      features: { bot_user: { display_name: "x".repeat(35) } },
    });
  });
});
