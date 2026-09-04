import type { ChannelAudience } from "#shared/channel-audience.js";
import { isObject } from "#shared/guards.js";

/** Resolves repository visibility without treating missing or malformed fields as public. */
export function githubRepositoryAudience(value: unknown): ChannelAudience {
  if (!isObject(value)) return "unknown";
  if (value.private === true) return "private";
  if (value.visibility === "private" || value.visibility === "internal") return "private";
  if ("private" in value && typeof value.private !== "boolean") return "unknown";
  if (
    "visibility" in value &&
    value.visibility !== "public" &&
    value.visibility !== "private" &&
    value.visibility !== "internal"
  ) {
    return "unknown";
  }
  if (value.visibility === "public") return "public";
  return "unknown";
}
