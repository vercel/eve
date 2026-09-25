import type { AppsManifestCreateArguments } from "@slack/web-api";

import { parseJsonObject, type JsonObject } from "#shared/json.js";

export const SLACK_APP_MANIFEST_TYPE = "https://docs.slack.dev/reference/app-manifest/";

type SlackManifest = AppsManifestCreateArguments["manifest"];
type SlackBotScope = NonNullable<
  NonNullable<NonNullable<SlackManifest["oauth_config"]>["scopes"]>["bot"]
>[number];
type SlackBotEvent = NonNullable<
  NonNullable<NonNullable<SlackManifest["settings"]>["event_subscriptions"]>["bot_events"]
>[number];

export interface SlackAppManifestOptions {
  readonly appName?: string;
  readonly backgroundColor?: string;
  readonly botDisplayName?: string;
  readonly botEvents?: readonly string[];
  readonly botScopes?: readonly string[];
  readonly description?: string;
  readonly optionalBotScopes?: readonly string[];
}
export interface SlackAppManifestBuildDefinition {
  readonly build: (channelName: string) => JsonObject;
}

export function defineSlackAppManifest(
  input: SlackAppManifestOptions,
): SlackAppManifestBuildDefinition {
  return {
    build(channelName) {
      const appName = (input.appName ?? channelName).slice(0, 35);
      const botDisplayName = normalizeBotDisplayName(input.botDisplayName ?? channelName);
      const requiredBotScopes = [
        ...unique(["app_mentions:read", "chat:write"], input.botScopes),
      ] as SlackBotScope[];
      const optionalBotScopes = unique([], input.optionalBotScopes).filter(
        (scope) => !requiredBotScopes.includes(scope as SlackBotScope),
      ) as SlackBotScope[];
      const oauthScopes: { bot: SlackBotScope[]; bot_optional?: SlackBotScope[] } = {
        bot: [...unique(requiredBotScopes, optionalBotScopes)] as SlackBotScope[],
      };
      if (optionalBotScopes.length > 0) oauthScopes.bot_optional = optionalBotScopes;
      const botEvents = [...unique(["app_mention"], input.botEvents)] as SlackBotEvent[];
      const displayInformation: {
        background_color?: string;
        description?: string;
        name: string;
      } = { name: appName };
      if (input.backgroundColor !== undefined) {
        displayInformation.background_color = input.backgroundColor;
      }
      if (input.description !== undefined) displayInformation.description = input.description;
      const manifest = {
        $type: SLACK_APP_MANIFEST_TYPE,
        display_information: displayInformation,
        features: {
          app_home: {
            home_tab_enabled: false,
            messages_tab_enabled: true,
            messages_tab_read_only_enabled: false,
          },
          bot_user: { display_name: botDisplayName },
        },
        oauth_config: { scopes: oauthScopes },
        settings: {
          event_subscriptions: { bot_events: botEvents },
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

function normalizeBotDisplayName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .slice(0, 35);
  return normalized.length > 0 ? normalized : "eve";
}

function unique(
  baseline: readonly string[],
  additional: readonly string[] = [],
): readonly string[] {
  return [...new Set([...baseline, ...additional])];
}
