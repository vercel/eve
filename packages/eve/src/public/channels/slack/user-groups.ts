const USER_GROUP_MENTION = /<!subteam\^([A-Z0-9]+)(?:\|[^>]+)?>/gu;

/** One Slack user-group mention found in message text. */
export interface SlackUserGroupMention {
  readonly id: string;
}

/**
 * Returns unique Slack user-group ids mentioned in text in first-mention
 * order. The parser deliberately retains Slack's opaque id rather than a
 * mutable display handle so channel-owned registries can verify ownership.
 */
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

/**
 * Removes one recognized user-group mention using the same whitespace
 * normalization callers use for an empty Slack app mention.
 */
export function withoutSlackUserGroupMention(text: string, userGroupId: string): string {
  return text
    .replace(USER_GROUP_MENTION, (mention, id: string) => (id === userGroupId ? "" : mention))
    .replace(/\s+/gu, " ")
    .trim();
}
