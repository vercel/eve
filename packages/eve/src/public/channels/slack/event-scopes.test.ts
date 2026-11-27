import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SLACK_EVENT_SCOPES } from "#public/channels/slack/event-scopes.js";

describe("SLACK_EVENT_SCOPES", () => {
  it("matches the payload types of the installed @slack/types, so run `node scripts/slack-event-scopes.mjs` and `npx oxfmt` on its output after upgrading it", async () => {
    const { deriveSlackEventScopes } = await import("../../../../scripts/slack-event-scopes.mjs");
    expect(deriveSlackEventScopes()).toEqual(SLACK_EVENT_SCOPES);
  });

  it("covers every event type @slack/types has, except the ones Slack documents no scopes for, the ones only a user token receives and app_rate_limited, which Slack posts without an event_callback envelope", async () => {
    const { derivePayloadPaths } = await import("../../../../scripts/slack-event-scopes.mjs");
    const typed = Object.keys(derivePayloadPaths());
    const offered = new Set(Object.keys(SLACK_EVENT_SCOPES).map((name) => name.split(".")[0]));
    expect(typed.filter((name) => !offered.has(name)).sort()).toEqual([
      "app_deleted",
      "app_rate_limited",
      "app_uninstalled_team",
      "invite_requested",
      "star_added",
      "star_removed",
      "user_connection_status_requested",
      "workflow_deleted",
      "workflow_published",
      "workflow_step_deleted",
      "workflow_step_execute",
      "workflow_unpublished",
    ]);
  });

  it("renders the event name types that subscriptions.ts imports, so running the generator keeps them", async () => {
    const { deriveSlackEventScopes, renderSlackEventScopes } =
      await import("../../../../scripts/slack-event-scopes.mjs");
    const rendered = renderSlackEventScopes(deriveSlackEventScopes());
    const types = rendered.slice(rendered.indexOf("/** A Slack bot event"));
    expect(readFileSync(new URL("./event-scopes.ts", import.meta.url), "utf8")).toContain(types);
  });

  it("scopes a timestamp only to events that carry a channel", () => {
    for (const [name, scope] of Object.entries(SLACK_EVENT_SCOPES))
      if (scope.timestamps.length > 0) expect(scope.channels.length, name).toBeGreaterThan(0);
  });

  it("reads each kind of event from where its payload carries the channel and message", () => {
    expect(SLACK_EVENT_SCOPES.reaction_added).toEqual({
      channels: ["item.channel"],
      timestamps: ["item.ts"],
      scopes: ["reactions:read"],
    });
    expect(SLACK_EVENT_SCOPES.app_mention.channels).toEqual(["channel"]);
    expect(SLACK_EVENT_SCOPES.app_mention.timestamps).toEqual(["thread_ts", "ts"]);
    expect(SLACK_EVENT_SCOPES.file_shared.channels).toEqual(["channel_id"]);
    expect(SLACK_EVENT_SCOPES.file_deleted.channels).toEqual(["channel_ids"]);
    expect(SLACK_EVENT_SCOPES.team_join).toEqual({
      channels: [],
      timestamps: [],
      scopes: ["users:read"],
    });
    expect(SLACK_EVENT_SCOPES["message.im"].scopes).toEqual(["im:history"]);
    expect(SLACK_EVENT_SCOPES["message.channels"].timestamps).toEqual([
      "deleted_ts",
      "message.deleted_ts",
      "message.thread_ts",
      "message.ts",
      "previous_message.deleted_ts",
      "previous_message.thread_ts",
      "previous_message.ts",
      "thread_ts",
      "ts",
    ]);
    expect(SLACK_EVENT_SCOPES.pin_added.timestamps).toEqual(["item.message.ts"]);
    expect(SLACK_EVENT_SCOPES.pin_removed.timestamps).toEqual(["item.message.ts"]);
  });
});
