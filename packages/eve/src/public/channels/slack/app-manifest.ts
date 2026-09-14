import type { AppsManifestCreateArguments } from "@slack/web-api";

import { parseJsonObject, type JsonObject } from "#shared/json.js";

type SlackManifest = AppsManifestCreateArguments["manifest"];
type SlackBotScope = NonNullable<
  NonNullable<NonNullable<SlackManifest["oauth_config"]>["scopes"]>["bot"]
>[number];
type SlackBotEvent = NonNullable<
  NonNullable<NonNullable<SlackManifest["settings"]>["event_subscriptions"]>["bot_events"]
>[number];

export interface SlackAppManifestOptions {
  readonly alwaysOnline?: boolean;
  readonly backgroundColor?: string;
  readonly botEvents?: readonly string[];
  readonly botScopes?: readonly string[];
  readonly description?: string;
  readonly displayName?: string;
  readonly longDescription?: string;
  readonly optionalBotScopes?: readonly string[];
  readonly requestUrl?: string;
}

export interface SlackAppManifestBuildDefinition {
  readonly build: (channelName: string) => JsonObject;
}

export function defineSlackAppManifest(
  input: SlackAppManifestOptions,
): SlackAppManifestBuildDefinition {
  return {
    build(channelName) {
      const name = (input.displayName ?? channelName).slice(0, 35);
      const botScopes = [
        ...unique(["app_mentions:read", "chat:write"], input.botScopes),
      ] as SlackBotScope[];
      const optionalBotScopes = unique([], input.optionalBotScopes).filter(
        (scope) => !botScopes.includes(scope as SlackBotScope),
      ) as SlackBotScope[];
      const oauthScopes: { bot: SlackBotScope[]; bot_optional?: SlackBotScope[] } = {
        bot: botScopes,
      };
      if (optionalBotScopes.length > 0) oauthScopes.bot_optional = optionalBotScopes;
      const botEvents = [...unique(["app_mention"], input.botEvents)] as SlackBotEvent[];
      const eventSubscriptions: {
        bot_events: SlackBotEvent[];
        request_url?: string;
      } = { bot_events: botEvents };
      const interactivity: { is_enabled: true; request_url?: string } = { is_enabled: true };
      if (input.requestUrl !== undefined) {
        eventSubscriptions.request_url = input.requestUrl;
        interactivity.request_url = input.requestUrl;
      }
      const displayInformation: {
        background_color?: string;
        description?: string;
        long_description?: string;
        name: string;
      } = { name };
      if (input.backgroundColor !== undefined) {
        displayInformation.background_color = input.backgroundColor;
      }
      if (input.description !== undefined) displayInformation.description = input.description;
      if (input.longDescription !== undefined) {
        displayInformation.long_description = input.longDescription;
      }
      const manifest = {
        display_information: displayInformation,
        features: {
          app_home: {
            home_tab_enabled: false,
            messages_tab_enabled: true,
            messages_tab_read_only_enabled: false,
          },
          bot_user: { display_name: name, always_online: input.alwaysOnline ?? false },
        },
        oauth_config: { scopes: oauthScopes },
        settings: {
          event_subscriptions: eventSubscriptions,
          interactivity,
          org_deploy_enabled: false,
          socket_mode_enabled: false,
          token_rotation_enabled: false,
        },
      } satisfies AppsManifestCreateArguments["manifest"];
      return manifest;
    },
  };
}

export function buildSlackAppManifest(value: unknown, channelName: string): JsonObject | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const build = (value as { readonly build?: unknown }).build;
  if (typeof build !== "function") return undefined;
  return parseJsonObject(build(channelName));
}

function unique(
  baseline: readonly string[],
  additional: readonly string[] = [],
): readonly string[] {
  return [...new Set([...baseline, ...additional])];
}
