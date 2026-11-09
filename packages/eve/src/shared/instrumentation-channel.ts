/** Stable authored channel identity, distinct from its storage adapter key. */
export type InstrumentationChannelKind =
  | `channel:${string}`
  | "http"
  | "schedule"
  | "subagent"
  | "unknown";

/** Base metadata for framework channel kinds. */
export type InstrumentationChannelMetadata = Readonly<Record<string, unknown>>;

/** Privacy-safe channel projection; metadata belongs to the channel. */
export interface InstrumentationChannelForKind<K extends InstrumentationChannelKind> {
  readonly kind: K;
  readonly continuationToken?: string;
  readonly metadata: InstrumentationChannelMetadata;
}

/** Channel shape received by instrumentation callbacks and dynamic resolvers. */
export type InstrumentationChannel = InstrumentationChannelForKind<InstrumentationChannelKind>;
