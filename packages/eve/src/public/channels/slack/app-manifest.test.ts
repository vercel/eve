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

  it("separates app and bot presentation and merges explicit requirements", () => {
    const definition = defineSlackAppManifest({
      app: { name: "x".repeat(40), description: "Support agent", backgroundColor: "#000000" },
      bot: { displayName: "Support Bot!" },
      scopes: ["im:history", "chat:write"],
      optionalScopes: ["im:history", "reactions:write", "reactions:write", "app_mentions:read"],
      eventSubscriptions: ["message.im", "app_mention", "message.im"],
    });

    expect(definition.build("support")).toMatchObject({
      display_information: {
        name: "x".repeat(35),
        description: "Support agent",
        background_color: "#000000",
      },
      features: { bot_user: { display_name: "support-bot" } },
      oauth_config: {
        scopes: {
          bot: ["app_mentions:read", "chat:write", "im:history", "reactions:write"],
          bot_optional: ["reactions:write"],
        },
      },
      settings: { event_subscriptions: { bot_events: ["app_mention", "message.im"] } },
    });
  });

  it.each([
    ["x".repeat(81), "x".repeat(80)],
    ["!!!", "eve"],
  ])("normalizes the bot display name %s", (displayName, expected) => {
    expect(defineSlackAppManifest({ bot: { displayName } }).build("support")).toMatchObject({
      features: { bot_user: { display_name: expected } },
    });
  });

  it("accepts the description limit and shorthand hex colors", () => {
    expect(
      defineSlackAppManifest({
        app: { description: "x".repeat(140), backgroundColor: "#aBc" },
      }).build("support"),
    ).toMatchObject({
      display_information: { description: "x".repeat(140), background_color: "#aBc" },
    });
  });

  it.each([
    [{ description: "x".repeat(141) }, "app.description"],
    [{ backgroundColor: "red" }, "app.backgroundColor"],
    [{ backgroundColor: "#1234" }, "app.backgroundColor"],
  ])("rejects invalid presentation %j during manifest generation", (app, field) => {
    expect(() => defineSlackAppManifest({ app }).build("support")).toThrow(field);
  });
});
