import { buildAdapterContext } from "#channel/adapter-context.js";
import { loadContext } from "#context/container.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import type { SlackApiResponse, SlackHandle } from "#public/channels/slack/api.js";

const USER_GROUP_MENTION = /<!subteam\^([A-Z0-9]+)(?:\|[^>]+)?>/gu;
const PREVIEW_AGENT_ROUTE_PREFIX = "eve:pa:1:";

/** One Slack user-group mention found in message text. */
export interface SlackUserGroupMention {
  readonly id: string;
}

/** Durable route metadata owned by the Slack bot's user group. */
export interface SlackPreviewAgentRoute {
  readonly alias: string;
  readonly branch: string;
  readonly description: string;
  readonly id: string;
  readonly url: string;
}

/** Input used when registering a Preview agent's Slack alias. */
export interface SlackPreviewAgentRegistration {
  readonly alias: string;
  readonly branch: string;
  readonly description: string;
  readonly url: string;
}

/** Returns unique Slack user-group ids mentioned in text in first-mention order. */
export function slackUserGroupMentions(text: string): readonly SlackUserGroupMention[] {
  const seen = new Set<string>();
  const mentions: SlackUserGroupMention[] = [];
  for (const match of text.matchAll(USER_GROUP_MENTION)) {
    const id = match[1];
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    mentions.push({ id });
  }
  return mentions;
}

/** Removes one recognized user-group mention using normalized Slack whitespace. */
export function withoutSlackUserGroupMention(text: string, userGroupId: string): string {
  return text
    .replace(USER_GROUP_MENTION, (mention, id: string) => (id === userGroupId ? "" : mention))
    .replace(/\s+/gu, " ")
    .trim();
}

/** Registers a Preview alias with the Slack bot bound to the active tool session. */
export async function registerCurrentSlackPreviewAgent(
  input: SlackPreviewAgentRegistration,
): Promise<SlackPreviewAgentRoute> {
  return await registerSlackPreviewAgent(input, currentSlack());
}

/** Disables a Preview alias with the Slack bot bound to the active tool session. */
export async function unregisterCurrentSlackPreviewAgent(alias: string): Promise<boolean> {
  return await unregisterSlackPreviewAgent(alias, currentSlack());
}

/** Creates or updates a bot-owned Slack user group used as a Preview alias. */
export async function registerSlackPreviewAgent(
  input: SlackPreviewAgentRegistration,
  slack: Pick<SlackHandle, "request" | "teamId">,
): Promise<SlackPreviewAgentRoute> {
  const route = normalizePreviewAgentRegistration(input);
  const teamId = required(slack.teamId, "Slack did not provide a workspace id.");
  const self = await slack.request("auth.test", {});
  requireOk("auth.test", self);
  requireMatchingTeam(self, teamId);
  const userId = requiredString(self.user_id, "Slack returned no bot user id.");

  const listed = await slack.request("usergroups.list", {
    include_disabled: true,
    include_users: true,
    team_id: teamId,
  });
  requireOk("usergroups.list", listed);
  const existing = userGroups(listed).find((group) => group.handle === route.alias);
  if (existing !== undefined) {
    if (!isOwnedBy(existing.record, userId)) {
      throw new Error(`Slack alias "${route.alias}" is already owned by another user.`);
    }
    const updated = await slack.request("usergroups.update", {
      description: encodePreviewAgentRoute(route),
      handle: route.alias,
      name: route.branch,
      team_id: teamId,
      usergroup: existing.id,
    });
    requireOk("usergroups.update", updated);
    if (!existing.enabled) {
      const enabled = await slack.request("usergroups.enable", {
        team_id: teamId,
        usergroup: existing.id,
      });
      requireOk("usergroups.enable", enabled);
    }
    return { ...route, id: existing.id };
  }

  const created = await slack.request("usergroups.create", {
    description: encodePreviewAgentRoute(route),
    handle: route.alias,
    name: route.branch,
    team_id: teamId,
  });
  requireOk("usergroups.create", created);
  const group = groupRecord(created.usergroup);
  const id = requiredString(group?.id, "Slack returned no user-group id.");
  const members = await slack.request("usergroups.users.update", {
    team_id: teamId,
    usergroup: id,
    users: userId,
  });
  requireOk("usergroups.users.update", members);
  return { ...route, id };
}

/** Disables a bot-owned alias, leaving Slack's immutable mention history intact. */
export async function unregisterSlackPreviewAgent(
  alias: string,
  slack: Pick<SlackHandle, "request" | "teamId">,
): Promise<boolean> {
  const normalizedAlias = normalizeAlias(alias);
  const teamId = required(slack.teamId, "Slack did not provide a workspace id.");
  const [self, listed] = await Promise.all([
    slack.request("auth.test", {}),
    slack.request("usergroups.list", { include_disabled: true, team_id: teamId }),
  ]);
  requireOk("auth.test", self);
  requireOk("usergroups.list", listed);
  requireMatchingTeam(self, teamId);
  const userId = requiredString(self.user_id, "Slack returned no bot user id.");
  const existing = userGroups(listed).find((group) => group.handle === normalizedAlias);
  if (existing === undefined) return false;
  if (!isOwnedBy(existing.record, userId)) {
    throw new Error(`Slack alias "${normalizedAlias}" is already owned by another user.`);
  }
  const response = await slack.request("usergroups.disable", {
    team_id: teamId,
    usergroup: existing.id,
  });
  requireOk("usergroups.disable", response);
  return true;
}

/** Resolves exactly one bot-owned Preview alias in a message, or returns no route. */
export async function resolveSlackPreviewAgentRoute(
  text: string,
  slack: Pick<SlackHandle, "request" | "teamId">,
): Promise<SlackPreviewAgentRoute | undefined> {
  const mentions = slackUserGroupMentions(text);
  if (mentions.length === 0) return undefined;
  const teamId = required(slack.teamId, "Slack did not provide a workspace id.");
  const [self, listed] = await Promise.all([
    slack.request("auth.test", {}),
    slack.request("usergroups.list", { include_disabled: false, team_id: teamId }),
  ]);
  requireOk("auth.test", self);
  requireOk("usergroups.list", listed);
  requireMatchingTeam(self, teamId);
  const userId = requiredString(self.user_id, "Slack returned no bot user id.");
  const routes = mentions.flatMap((mention) => {
    const group = userGroups(listed).find((candidate) => candidate.id === mention.id);
    if (group === undefined || !isOwnedBy(group.record, userId)) return [];
    const route = decodePreviewAgentRoute({
      alias: group.handle,
      branch: group.name,
      value: group.description,
    });
    return route === undefined ? [] : [{ ...route, id: group.id }];
  });
  if (routes.length > 1) throw new Error("Mention exactly one registered Preview agent.");
  return routes[0];
}

function currentSlack(): Pick<SlackHandle, "request" | "teamId"> {
  const ctx = loadContext();
  const adapterContext = buildAdapterContext(ctx.require(ChannelKey), ctx);
  const slack = Reflect.get(adapterContext, "slack");
  if (slack === null || typeof slack !== "object") {
    throw new Error("Slack Preview aliases can only be managed from a Slack channel session.");
  }
  const request = Reflect.get(slack, "request");
  const teamId = Reflect.get(slack, "teamId");
  if (typeof request !== "function" || (teamId !== undefined && typeof teamId !== "string")) {
    throw new Error("Slack Preview aliases can only be managed from a Slack channel session.");
  }
  return { request: request as SlackHandle["request"], teamId };
}

function normalizePreviewAgentRegistration(
  input: SlackPreviewAgentRegistration,
): Omit<SlackPreviewAgentRoute, "id"> {
  const branch = required(input.branch.trim(), "Preview branch is required.");
  const description = required(input.description.trim(), "Preview description is required.");
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error("Preview URL must be a valid HTTPS origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("Preview URL must be a plain HTTPS origin.");
  }
  return { alias: normalizeAlias(input.alias), branch, description, url: url.origin };
}

function normalizeAlias(value: string): string {
  const alias = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(alias)) {
    throw new Error(
      "Preview alias must be 1–80 lowercase letters, digits, dots, underscores, or hyphens.",
    );
  }
  return alias;
}

function encodePreviewAgentRoute(route: Omit<SlackPreviewAgentRoute, "id">): string {
  return `${PREVIEW_AGENT_ROUTE_PREFIX}${route.url}`;
}

function decodePreviewAgentRoute(input: {
  readonly alias: string;
  readonly branch: string | undefined;
  readonly value: unknown;
}): Omit<SlackPreviewAgentRoute, "id"> | undefined {
  if (typeof input.value !== "string" || !input.value.startsWith(PREVIEW_AGENT_ROUTE_PREFIX)) {
    return undefined;
  }
  if (input.branch === undefined) return undefined;
  try {
    return normalizePreviewAgentRegistration({
      alias: input.alias,
      branch: input.branch,
      description: `Preview Deployment for ${input.branch}.`,
      url: input.value.slice(PREVIEW_AGENT_ROUTE_PREFIX.length),
    });
  } catch {
    return undefined;
  }
}

function userGroups(response: SlackApiResponse): Array<{
  id: string;
  handle: string;
  description?: string;
  enabled: boolean;
  name?: string;
  record: Record<string, unknown>;
}> {
  if (!Array.isArray(response.usergroups)) return [];
  return response.usergroups.flatMap((value) => {
    const record = groupRecord(value);
    if (record === undefined) return [];
    const id = optionalString(record.id);
    const handle = optionalString(record.handle);
    return id === undefined || handle === undefined
      ? []
      : [
          {
            id,
            handle,
            description: optionalString(record.description),
            enabled: record.is_enabled !== false,
            name: optionalString(record.name),
            record,
          },
        ];
  });
}

function groupRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isOwnedBy(group: Record<string, unknown> | undefined, userId: string): boolean {
  return group?.created_by === userId && group.updated_by === userId;
}

function requireOk(operation: string, response: SlackApiResponse): void {
  if (response.ok) return;
  const needed = optionalString(response.needed);
  throw new Error(
    `Slack ${operation} failed: ${optionalString(response.error) ?? "unknown_error"}${
      needed === undefined ? "" : ` (required scope: ${needed})`
    }.`,
  );
}

function requireMatchingTeam(response: SlackApiResponse, teamId: string): void {
  const authenticatedTeam = optionalString(response.team_id);
  if (authenticatedTeam !== undefined && authenticatedTeam !== teamId) {
    throw new Error("Slack authenticated a different workspace.");
  }
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function requiredString(value: unknown, message: string): string {
  return required(optionalString(value) ?? "", message);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
