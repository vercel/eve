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
      oauth_config: {
        scopes: {
          bot: [
            "app_mentions:read",
            "channels:history",
            "chat:write",
            "groups:history",
            "im:history",
            "mpim:history",
          ],
        },
      },
      settings: {
        event_subscriptions: {
          bot_events: [
            "app_mention",
            "message.channels",
            "message.groups",
            "message.im",
            "message.mpim",
          ],
        },
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

  it("adds Slack code channel scopes, events, and feature flag", () => {
    expect(defineSlackAppManifest({ codeChannels: true }).build("support")).toMatchObject({
      features: { code_channels: { enabled: true } },
      oauth_config: {
        scopes: {
          bot: [
            "app_mentions:read",
            "channels:history",
            "chat:write",
            "groups:history",
            "im:history",
            "mpim:history",
            "channels:read",
            "code_channels:manage",
            "groups:read",
            "im:read",
            "mpim:read",
          ],
        },
      },
      settings: {
        event_subscriptions: {
          bot_events: [
            "app_mention",
            "message.channels",
            "message.groups",
            "message.im",
            "message.mpim",
            "agent_session_stopped",
            "message.session",
          ],
        },
      },
    });
  });

  it("adds users:read for names and users:read.email only for emails", () => {
    const botScopes = (options: { users?: boolean; userEmails?: boolean }) =>
      (
        defineSlackAppManifest(options).build("support") as {
          oauth_config: { scopes: { bot: string[] } };
        }
      ).oauth_config.scopes.bot;

    expect(botScopes({ users: true })).toContain("users:read");
    expect(botScopes({ users: true })).not.toContain("users:read.email");
    expect(botScopes({ users: true, userEmails: true })).toEqual(
      expect.arrayContaining(["users:read", "users:read.email"]),
    );
  });

  it("adds the events and bot scopes of the subscribed events, and the scopes that check channel membership", () => {
    const manifest = defineSlackAppManifest({
      subscriptionEvents: ["reaction_added", "team_join"],
    }).build("support") as {
      oauth_config: { scopes: { bot: string[] } };
      settings: { event_subscriptions: { bot_events: string[] } };
    };

    expect(manifest.settings.event_subscriptions.bot_events).toEqual([
      "app_mention",
      "message.channels",
      "message.groups",
      "message.im",
      "message.mpim",
      "reaction_added",
      "team_join",
    ]);
    expect(manifest.oauth_config.scopes.bot).toEqual(
      expect.arrayContaining([
        "chat:write",
        "reactions:read",
        "users:read",
        "channels:read",
        "groups:read",
        "im:read",
        "mpim:read",
      ]),
    );
  });

  it("lists an event or scope once when subscribed events, defaults and code channels repeat it", () => {
    const manifest = defineSlackAppManifest({
      codeChannels: true,
      subscriptionEvents: ["app_mention", "message.im", "reaction_added"],
      users: true,
    }).build("support") as {
      oauth_config: { scopes: { bot: string[] } };
      settings: { event_subscriptions: { bot_events: string[] } };
    };
    const { bot } = manifest.oauth_config.scopes;
    const { bot_events } = manifest.settings.event_subscriptions;

    expect(new Set(bot).size).toBe(bot.length);
    expect(new Set(bot_events).size).toBe(bot_events.length);
    expect(bot).toEqual(expect.arrayContaining(["code_channels:manage", "reactions:read"]));
    expect(bot_events).toEqual(expect.arrayContaining(["reaction_added", "message.session"]));
  });

  it("keeps the native baseline when no events are subscribed", () => {
    expect(defineSlackAppManifest({ subscriptionEvents: [] }).build("support")).toMatchObject({
      settings: {
        event_subscriptions: {
          bot_events: [
            "app_mention",
            "message.channels",
            "message.groups",
            "message.im",
            "message.mpim",
          ],
        },
      },
    });
  });
});
