import type { AppsManifestCreateArguments } from "@slack/web-api";

import type { JsonObject } from "#shared/json.js";

const SLACK_APP_MANIFEST_TYPE = "https://docs.slack.dev/reference/app-manifest/";

interface SlackAppManifestBuildDefinition {
  readonly build: (channelName: string) => JsonObject;
}

export function defineSlackAppManifest(input: {
  readonly botName?: string;
}): SlackAppManifestBuildDefinition {
  return {
    build(channelName) {
      const name = (input.botName ?? channelName).slice(0, 35);
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
        oauth_config: { scopes: { bot: ["app_mentions:read", "chat:write"] } },
        settings: {
          event_subscriptions: { bot_events: ["app_mention"] },
          org_deploy_enabled: false,
          socket_mode_enabled: false,
          token_rotation_enabled: false,
        },
      } satisfies AppsManifestCreateArguments["manifest"];
      return manifest;
    },
  };
}
