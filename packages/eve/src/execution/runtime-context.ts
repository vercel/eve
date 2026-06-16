import type { RunInput, SessionAuthContext } from "#channel/types.js";
import { ContextContainer } from "#context/container.js";
import { setChannelContext } from "#execution/channel-context.js";
import {
  AuthKey,
  CapabilitiesKey,
  ChannelInstrumentationKey,
  ContinuationTokenKey,
  InitiatorAuthKey,
  ModeKey,
  ParentSessionKey,
  SessionCallbackKey,
} from "#context/keys.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";

/**
 * Builds the bootstrap {@link ContextContainer} for one run.
 */
export function buildRunContext(input: {
  readonly bundle: CompiledBundle;
  readonly run: RunInput;
}): ContextContainer {
  const { bundle, run } = input;
  const ctx = new ContextContainer();
  const auth: SessionAuthContext | null = run.auth;

  ctx.set(BundleKey, bundle);
  setChannelContext(ctx, run.adapter, { channelName: run.channelName });

  if (run.channelMetadata !== undefined) {
    const existing = ctx.get(ChannelInstrumentationKey);
    ctx.set(ChannelInstrumentationKey, {
      kind: existing?.kind ?? run.channelMetadata.kind,
      metadata: run.channelMetadata.metadata,
    });
  }

  ctx.set(ContinuationTokenKey, run.continuationToken ?? "");
  ctx.set(ModeKey, run.mode);
  ctx.set(AuthKey, auth);
  ctx.set(InitiatorAuthKey, run.initiatorAuth ?? auth);

  if (run.capabilities !== undefined) {
    ctx.set(CapabilitiesKey, run.capabilities);
  }

  if (run.callback !== undefined) {
    ctx.set(SessionCallbackKey, run.callback);
  }

  if (run.parent !== undefined) {
    ctx.set(ParentSessionKey, run.parent);
  }

  return ctx;
}
