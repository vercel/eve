import { expectObjectRecord, expectOnlyKnownKeys } from "#internal/authored-module.js";
import type { ConnectionTags } from "#shared/connection-types.js";

/** Tags ride on every `call.requested` event, so each entry's set stays small. */
const MAX_TAGS = 32;
const MAX_TAG_LENGTH = 128;

/** Validates an entry's `tags`: a short list of non-empty strings, deduplicated in order. */
export function normalizeTags(value: unknown, message: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${message} "tags" must be an array of strings.`);
  for (const tag of value) {
    if (typeof tag !== "string" || tag.length === 0 || tag.length > MAX_TAG_LENGTH) {
      throw new Error(
        `${message} Each tag must be a non-empty string of at most ${MAX_TAG_LENGTH} characters.`,
      );
    }
  }
  const tags = [...new Set(value as string[])];
  if (tags.length > MAX_TAGS) {
    throw new Error(`${message} An entry can have at most ${MAX_TAGS} tags.`);
  }
  return Object.freeze(tags);
}

/** Validates a connection's `tags`: one list for every tool, or a default with per-tool lists. */
export function normalizeConnectionTags(value: unknown, message: string): ConnectionTags {
  if (Array.isArray(value)) return normalizeTags(value, message);
  const record = expectObjectRecord(
    value,
    `${message} "tags" must be an array of strings or { default?, tools? }.`,
  );
  expectOnlyKnownKeys(record, ["default", "tools"], `${message} The "tags" field`);
  const tools =
    record.tools === undefined
      ? undefined
      : Object.freeze(
          Object.fromEntries(
            Object.entries(
              expectObjectRecord(record.tools, `${message} "tags.tools" must be an object.`),
            ).map(([toolName, tags]) => [toolName, normalizeTags(tags, message)]),
          ),
        );
  return Object.freeze({
    ...(record.default !== undefined && { default: normalizeTags(record.default, message) }),
    ...(tools !== undefined && { tools }),
  });
}

/** The tags of one connection tool: its own list replaces the connection's default. */
export function connectionToolTags(
  tags: ConnectionTags | undefined,
  toolName: string,
): readonly string[] | undefined {
  if (tags === undefined || isTagList(tags)) return tags;
  return tags.tools !== undefined && Object.hasOwn(tags.tools, toolName)
    ? tags.tools[toolName]
    : tags.default;
}

function isTagList(tags: ConnectionTags): tags is readonly string[] {
  return Array.isArray(tags);
}
