import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const scopesModulePath = join(packageRoot, "src", "public", "channels", "slack", "event-scopes.ts");

/**
 * The bot OAuth scopes each event needs, from the "Required Scopes" fact on
 * https://docs.slack.dev/reference/events/<event>. Several scopes on one event are alternatives:
 * Slack asks for the one that matches the conversation type the event happens in. `message` is
 * split into the four manifest events it is delivered as. `workflow_*` and
 * `user_connection_status_requested` have no reference page, so they are not offered.
 */
export const REQUIRED_BOT_SCOPES = {
  agent_session_stopped: ["chat:write"],
  agent_session_title_changed: ["chat:write"],
  app_context_changed: ["assistant:write"],
  app_deleted: ["admin.apps:read"],
  app_home_opened: [],
  app_installed: [],
  app_mention: ["app_mentions:read"],
  app_rate_limited: [],
  app_requested: [],
  app_uninstalled: [],
  app_uninstalled_team: ["admin.apps:read"],
  assistant_thread_context_changed: [],
  assistant_thread_started: [],
  call_rejected: [],
  channel_archive: [],
  channel_created: ["channels:read"],
  channel_deleted: ["channels:read"],
  channel_history_changed: ["channels:history", "groups:history", "mpim:history"],
  channel_id_changed: [],
  channel_left: ["channels:read"],
  channel_rename: ["channels:read"],
  channel_shared: ["channels:read", "groups:read"],
  channel_unarchive: [],
  channel_unshared: ["channels:read", "groups:read"],
  dnd_updated: ["dnd:read"],
  dnd_updated_user: ["dnd:read"],
  email_domain_changed: ["team:read"],
  emoji_changed: ["emoji:read"],
  entity_details_requested: [],
  file_change: ["files:read"],
  file_comment_deleted: ["files:read"],
  file_created: ["files:read"],
  file_deleted: ["files:read"],
  file_public: ["files:read"],
  file_shared: ["files:read"],
  file_unshared: ["files:read"],
  function_executed: [],
  grid_migration_finished: [],
  grid_migration_started: [],
  group_archive: [],
  group_close: ["groups:read"],
  group_deleted: ["groups:read"],
  group_history_changed: ["groups:history"],
  group_left: ["groups:read"],
  group_open: ["groups:read"],
  group_rename: ["groups:read"],
  group_unarchive: [],
  im_close: ["im:read"],
  im_created: ["im:read"],
  im_history_changed: ["im:history"],
  im_open: ["im:read"],
  invite_requested: ["admin.invites:read"],
  link_shared: ["links:read"],
  member_joined_channel: ["channels:read", "groups:read", "mpim:read"],
  member_left_channel: ["channels:read", "groups:read"],
  "message.channels": ["channels:history"],
  "message.groups": ["groups:history"],
  "message.im": ["im:history"],
  "message.mpim": ["mpim:history"],
  message_metadata_deleted: ["metadata.message:read"],
  message_metadata_posted: ["metadata.message:read"],
  message_metadata_updated: ["metadata.message:read"],
  pin_added: ["pins:read"],
  pin_removed: ["pins:read"],
  reaction_added: ["reactions:read"],
  reaction_removed: ["reactions:read"],
  shared_channel_invite_accepted: [],
  shared_channel_invite_approved: [],
  shared_channel_invite_declined: [],
  shared_channel_invite_received: [],
  shared_channel_invite_requested: [],
  star_added: ["stars:read"],
  star_removed: ["stars:read"],
  subteam_created: ["usergroups:read"],
  subteam_members_changed: ["usergroups:read"],
  subteam_self_added: ["usergroups:read"],
  subteam_self_removed: ["usergroups:read"],
  subteam_updated: ["usergroups:read"],
  team_access_granted: [],
  team_access_revoked: [],
  team_domain_change: ["team:read"],
  team_join: ["users:read"],
  team_rename: ["team:read"],
  tokens_revoked: [],
  user_change: ["users:read"],
  user_connection: ["users:write"],
  user_huddle_changed: ["users:read"],
  user_profile_changed: ["users:read"],
  user_status_changed: ["users:read"],
};

const CHANNEL_LEAVES = new Set(["channel", "channel_id", "channel_ids"]);
const TIMESTAMP_LEAVES = new Set(["ts", "thread_ts", "message_ts"]);
const MESSAGE_EVENTS = ["message.channels", "message.groups", "message.im", "message.mpim"];
// Slack repeats a changed or deleted message's earlier state here, with the same ids.
const SKIPPED_PROPERTIES = new Set(["previous_message"]);

/**
 * Walks every string-typed path of each Events API payload in `@slack/types` and keeps the paths
 * that hold a channel id and the paths that hold a message or thread timestamp. A path that ends in
 * `channel_ids` holds a list of channel ids. A timestamp is only scoped when the payload also
 * carries a channel, because a timestamp names a message only within its channel.
 */
export function derivePayloadPaths() {
  const ts = require("@typescript/typescript6");
  const typesDirectory = dirname(require.resolve("@slack/types/package.json"));
  const entry = join(typesDirectory, "dist", "events", "index.d.ts");
  const program = ts.createProgram([entry], { noEmit: true, skipLibCheck: true, strict: true });
  const checker = program.getTypeChecker();
  const module = checker.getSymbolAtLocation(program.getSourceFile(entry));
  const slackEvent = checker.getDeclaredTypeOfSymbol(
    checker.getExportsOfModule(module).find((symbol) => symbol.name === "SlackEvent"),
  );

  const paths = new Map();
  const collect = (type, prefix, visiting, found) => {
    for (const property of checker.getPropertiesOfType(type)) {
      if (SKIPPED_PROPERTIES.has(property.name)) continue;
      const path = prefix === "" ? property.name : `${prefix}.${property.name}`;
      const propertyType = checker.getNonNullableType(checker.getTypeOfSymbol(property));
      for (const part of propertyType.isUnion() ? propertyType.types : [propertyType]) {
        if (part.flags & ts.TypeFlags.StringLike) {
          found.add(path);
        } else if (checker.isArrayType(part)) {
          const [element] = checker.getTypeArguments(part);
          if (element !== undefined && element.flags & ts.TypeFlags.StringLike) found.add(path);
        } else if (part.flags & ts.TypeFlags.Object && !visiting.has(part)) {
          visiting.add(part);
          collect(part, path, visiting, found);
          visiting.delete(part);
        }
      }
    }
  };
  for (const member of slackEvent.isUnion() ? slackEvent.types : [slackEvent]) {
    const name = JSON.parse(
      checker.typeToString(checker.getTypeOfSymbol(member.getProperty("type"))),
    );
    const found = paths.get(name) ?? new Set();
    collect(member, "", new Set([member]), found);
    paths.set(name, found);
  }

  const leaf = (path) => path.slice(path.lastIndexOf(".") + 1);
  const isChannel = (path) =>
    CHANNEL_LEAVES.has(leaf(path)) || path === "channel.id" || path.endsWith(".channel.id");
  const isTimestamp = (path) =>
    TIMESTAMP_LEAVES.has(leaf(path)) && !path.split(".").includes("edited");
  const result = {};
  for (const [name, found] of paths) {
    const channels = [...found].filter(isChannel).sort();
    const timestamps = channels.length === 0 ? [] : [...found].filter(isTimestamp).sort();
    result[name] = { channels, timestamps };
  }
  return result;
}

export function deriveSlackEventScopes() {
  const payloads = derivePayloadPaths();
  const scopes = {};
  for (const [name, scopesNeeded] of Object.entries(REQUIRED_BOT_SCOPES)) {
    const payload = MESSAGE_EVENTS.includes(name) ? payloads.message : payloads[name];
    if (payload === undefined)
      throw new Error(`@slack/types has no payload for the "${name}" event.`);
    scopes[name] = { ...payload, scopes: scopesNeeded };
  }
  return scopes;
}

export function renderSlackEventScopes(scopes) {
  const list = (values) => `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
  const rows = Object.entries(scopes).map(
    ([name, { channels, timestamps, scopes: needed }]) =>
      `  ${JSON.stringify(name)}: { channels: ${list(channels)}, timestamps: ${list(timestamps)}, scopes: ${list(needed)} },`,
  );
  return [
    "export interface SlackEventScope {",
    "  /** Dot-paths in the event payload that hold a channel id, or a list of channel ids. */",
    "  readonly channels: readonly string[];",
    "  /** Dot-paths in the event payload that hold a message or thread timestamp. */",
    "  readonly timestamps: readonly string[];",
    "  /** Bot OAuth scopes of which the bot needs at least one to receive the event. */",
    "  readonly scopes: readonly string[];",
    "}",
    "",
    "export const SLACK_EVENT_SCOPES = {",
    ...rows,
    "} as const satisfies Record<string, SlackEventScope>;",
    "",
    "/** A Slack bot event, named as in the app manifest's `bot_events`, such as `reaction_added` or `message.channels`. */",
    "export type SlackEventName = keyof typeof SLACK_EVENT_SCOPES;",
    "",
    "/** The events a Slack app built by eve subscribes to when `experimental.subscriptions.events` is not set. */",
    "export const DEFAULT_SLACK_SUBSCRIPTION_EVENTS = [",
    '  "app_mention",',
    '  "message.channels",',
    '  "message.groups",',
    '  "message.im",',
    '  "message.mpim",',
    "] as const satisfies readonly SlackEventName[];",
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeFile(scopesModulePath, renderSlackEventScopes(deriveSlackEventScopes()));
}
