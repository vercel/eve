import type { AppsManifestCreateArguments } from "@slack/web-api";

import {
  DEFAULT_SLACK_SUBSCRIPTION_EVENTS,
  SLACK_EVENT_SCOPES,
  type SlackEventName,
} from "#public/channels/slack/event-scopes.js";
import type { JsonObject } from "#shared/json.js";

type ManifestSettings = NonNullable<AppsManifestCreateArguments["manifest"]["settings"]>;
type ManifestEvent = NonNullable<
  NonNullable<ManifestSettings["event_subscriptions"]>["bot_events"]
>[number];
type BotScope = NonNullable<
  NonNullable<NonNullable<AppsManifestCreateArguments["manifest"]["oauth_config"]>["scopes"]>["bot"]
>[number];

const SLACK_APP_MANIFEST_TYPE = "https://docs.slack.dev/reference/app-manifest/";

interface SlackAppManifestBuildDefinition {
  readonly build: (channelName: string) => JsonObject;
}

export function defineSlackAppManifest(input: {
  readonly botName?: string;
  readonly codeChannels?: boolean;
  readonly users?: boolean;
  readonly userEmails?: boolean;
  readonly subscriptionEvents?: readonly SlackEventName[];
}): SlackAppManifestBuildDefinition {
  return {
    build(channelName) {
      const name = (input.botName ?? channelName).slice(0, 35);
      const subscribed = subscriptionManifest(input.subscriptionEvents);
      const botScopes = [
        ...new Set<BotScope>([
          "app_mentions:read",
          "channels:history",
          "chat:write",
          "groups:history",
          "im:history",
          "mpim:history",
          ...(input.users === true ? ["users:read" as const] : []),
          ...(input.users === true && input.userEmails === true
            ? ["users:read.email" as const]
            : []),
          ...subscribed.scopes,
        ]),
      ];
      const manifest = {
        $type: SLACK_APP_MANIFEST_TYPE,
        display_information: { name },
        features: {
          app_home: {
            home_tab_enabled: false,
            messages_tab_enabled: true,
            messages_tab_read_only_enabled: false,
          },
          bot_user: { display_name: name },
        },
        oauth_config: { scopes: { bot: botScopes } },
        settings: {
          event_subscriptions: {
            bot_events: subscribed.events,
          },
          org_deploy_enabled: false,
          socket_mode_enabled: false,
          token_rotation_enabled: false,
        },
      } satisfies AppsManifestCreateArguments["manifest"];
      return input.codeChannels === true ? withCodeChannels(manifest) : manifest;
    },
  };
}

const MEMBERSHIP_SCOPES = ["channels:read", "groups:read", "im:read", "mpim:read"] as const;

function subscriptionManifest(subscriptionEvents: readonly SlackEventName[] | undefined): {
  readonly events: ManifestEvent[];
  readonly scopes: BotScope[];
} {
  if (subscriptionEvents === undefined) {
    return { events: [...DEFAULT_SLACK_SUBSCRIPTION_EVENTS], scopes: [] };
  }
  const events = [
    ...new Set<SlackEventName>([...DEFAULT_SLACK_SUBSCRIPTION_EVENTS, ...subscriptionEvents]),
  ];
  return {
    events: events as ManifestEvent[],
    scopes: [
      ...events.flatMap((event) => SLACK_EVENT_SCOPES[event].scopes),
      ...MEMBERSHIP_SCOPES,
    ] as BotScope[],
  };
}

function withCodeChannels(manifest: {
  readonly features: object;
  readonly oauth_config: { readonly scopes: { readonly bot: readonly string[] } };
  readonly settings: { readonly event_subscriptions: { readonly bot_events: readonly string[] } };
}): JsonObject {
  return {
    ...manifest,
    features: { ...manifest.features, code_channels: { enabled: true } },
    oauth_config: {
      scopes: {
        bot: [
          ...new Set([
            ...manifest.oauth_config.scopes.bot,
            "channels:read",
            "code_channels:manage",
            "groups:read",
            "im:read",
            "mpim:read",
          ]),
        ],
      },
    },
    settings: {
      ...manifest.settings,
      event_subscriptions: {
        bot_events: [
          ...new Set([
            ...manifest.settings.event_subscriptions.bot_events,
            "agent_session_stopped",
            "message.session",
          ]),
        ],
      },
    },
  } as JsonObject;
}
