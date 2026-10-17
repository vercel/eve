/** Stable authored channel identity, distinct from its storage adapter key. */
export type ChannelKind = `channel:${string}` | "http" | "schedule" | "subagent" | "unknown";
/** Privacy-safe channel projection; metadata belongs to the channel. */
export interface ChannelInfo<TMetadata = Readonly<Record<string, unknown>>> {
  readonly kind: ChannelKind;
  readonly continuationToken?: string;
  readonly metadata: TMetadata;
}
