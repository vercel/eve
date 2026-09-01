export const CHANNEL_AUDIENCES = ["public", "private", "unknown"] as const;

/** Who can observe the conversation on its originating channel. */
export type ChannelAudience = (typeof CHANNEL_AUDIENCES)[number];

export interface ChannelAudienceMetadata {
  readonly audience?: ChannelAudience;
}

export function normalizeChannelAudience(value: unknown): ChannelAudience {
  return typeof value === "string" && CHANNEL_AUDIENCES.includes(value as ChannelAudience)
    ? (value as ChannelAudience)
    : "unknown";
}
