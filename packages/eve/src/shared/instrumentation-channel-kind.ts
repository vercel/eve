import type { InstrumentationChannelKind } from "#public/channels/index.js";

const FRAMEWORK_CHANNEL_KINDS: ReadonlySet<string> = new Set(["http", "schedule", "subagent"]);

export function isInstrumentationChannelKind(kind: string): kind is InstrumentationChannelKind {
  return kind.startsWith("channel:") || FRAMEWORK_CHANNEL_KINDS.has(kind);
}

export function normalizeInstrumentationChannelKind(
  rawKind: string | undefined,
): InstrumentationChannelKind {
  return rawKind !== undefined && isInstrumentationChannelKind(rawKind) ? rawKind : "unknown";
}
