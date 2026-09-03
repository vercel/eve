export interface SlackAppManifestOptions {
  /** Additional Slack bot OAuth scopes required by this channel. */
  readonly botScopes?: readonly string[];
  /** Additional Slack Events API bot events delivered to this channel. */
  readonly botEvents?: readonly string[];
}

export interface SlackAppManifestMetadata extends SlackAppManifestOptions {
  readonly displayName?: string;
}

export function extractSlackAppManifestMetadata(
  value: unknown,
): SlackAppManifestMetadata | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { botEvents, botScopes, displayName } = value as {
    readonly botEvents?: unknown;
    readonly botScopes?: unknown;
    readonly displayName?: unknown;
  };
  const metadata: {
    botEvents?: readonly string[];
    botScopes?: readonly string[];
    displayName?: string;
  } = {};
  if (typeof displayName === "string" && displayName.length > 0) {
    metadata.displayName = displayName;
  }
  if (isStringList(botScopes)) metadata.botScopes = botScopes;
  if (isStringList(botEvents)) metadata.botEvents = botEvents;
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

function isStringList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}
