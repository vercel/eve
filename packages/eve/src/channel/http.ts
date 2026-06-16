import type { ChannelAdapter } from "#channel/adapter.js";

/**
 * Durable adapter kind for the canonical session channel and for every
 * behaviorless user-authored channel returned by the `defineChannel`
 * fast-path (no state, no `context()`, no event handlers, no `fetchFile`).
 *
 * The value is locked at `"http"` because it is persisted into durable
 * workflow state under `serializedContext["eve.channel"].kind` and into
 * sandbox telemetry tags as `channel: "http"`. Renaming the value would
 * break rehydration for every in-flight session started under any prior
 * build with "Unknown adapter kind: \"http\"". The `httpChannel` →
 * `eveChannel` rename (commit `bd3d1b43`) intentionally renamed the
 * channel identifier (file name, function name, framework constant) but
 * deliberately left this adapter kind alone — the kind labels the
 * adapter's transport class, not the channel's name, and the same slot
 * is the rehydration target for every behaviorless authored channel
 * regardless of which protocol it speaks.
 */
export const HTTP_ADAPTER_KIND = "http";

/**
 * Framework adapter installed for the canonical session channel and
 * for every behaviorless user-authored channel.
 *
 * Carries no behavior — it is a bare discriminator that the runtime
 * adapter registry uses to rehydrate `{ kind: "http" }` at every
 * workflow step boundary. Registered in `FRAMEWORK_ADAPTERS`
 * (`runtime/channels/registry.ts`).
 */
export const HTTP_ADAPTER: ChannelAdapter = {
  kind: HTTP_ADAPTER_KIND,
};
