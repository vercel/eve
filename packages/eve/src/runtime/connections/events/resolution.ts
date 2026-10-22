import type { DynamicConnectionResolveContext } from "#public/definitions/connections/dynamic.js";
import type { RuntimeIdentity } from "#protocol/message.js";

/** Trusted input that reconstructs one session-scoped connection after a cold start. */
export interface DynamicEventResolution {
  readonly sourceId: string;
  readonly slug: string;
  readonly runtime?: RuntimeIdentity;
  readonly context: DynamicConnectionResolveContext;
}
