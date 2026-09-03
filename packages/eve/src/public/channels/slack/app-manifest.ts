export interface SlackAppManifestMetadata {
  readonly alwaysOnline?: boolean;
  readonly backgroundColor?: string;
  readonly botEvents?: readonly string[];
  readonly botScopes?: readonly string[];
  readonly description?: string;
  readonly displayName?: string;
  readonly longDescription?: string;
}

export function extractSlackAppManifestMetadata(
  value: unknown,
): SlackAppManifestMetadata | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const {
    alwaysOnline,
    backgroundColor,
    botEvents,
    botScopes,
    description,
    displayName,
    longDescription,
  } = value as Record<string, unknown>;
  const metadata: {
    alwaysOnline?: boolean;
    backgroundColor?: string;
    botEvents?: readonly string[];
    botScopes?: readonly string[];
    description?: string;
    displayName?: string;
    longDescription?: string;
  } = {};
  if (typeof alwaysOnline === "boolean") metadata.alwaysOnline = alwaysOnline;
  if (isNonEmptyString(backgroundColor)) metadata.backgroundColor = backgroundColor;
  if (isStringList(botEvents)) metadata.botEvents = botEvents;
  if (isStringList(botScopes)) metadata.botScopes = botScopes;
  if (isNonEmptyString(description)) metadata.description = description;
  if (isNonEmptyString(displayName)) metadata.displayName = displayName;
  if (isNonEmptyString(longDescription)) metadata.longDescription = longDescription;
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}
