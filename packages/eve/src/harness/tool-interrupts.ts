/**
 * Per-step holding pen for the full interrupt signal a tool returns from
 * `execute`.
 *
 * A tool signals a park (e.g. connection OAuth) by *returning* an
 * {@link AuthorizationSignal}. The AI SDK records that return value as the
 * tool-result `output`, which `experimental_telemetry`'s `recordOutputs`
 * exports to OTel spans. So the {@link "#harness/tools.js"} wrapper hands the
 * AI SDK a `resume`-redacted copy of the signal and stashes the full signal
 * here; the park detector reads it back so the journaled challenges keep
 * their `resume` value.
 *
 * Virtual context: never serialized, wiped each step. Set during `execute`
 * and read post-step within the same `runStep` scope, so the slot always
 * outlives the read and never crosses a boundary.
 */

import type { AlsContext, ContextContainer } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import type { AuthorizationSignal } from "#harness/authorization.js";

const PendingToolInterruptsKey = new ContextKey<Readonly<Record<string, AuthorizationSignal>>>(
  "eve.pendingToolInterrupts",
);

/** Stashes a tool's full interrupt signal under its `toolCallId` for the current step. */
export function stashToolInterrupt(
  ctx: AlsContext,
  toolCallId: string,
  signal: AuthorizationSignal,
): void {
  const existing = ctx.get(PendingToolInterruptsKey) ?? {};
  asContainer(ctx).setVirtualContext(PendingToolInterruptsKey, {
    ...existing,
    [toolCallId]: signal,
  });
}

/** Reads the full interrupt signal stashed for `toolCallId`, if any. */
export function readToolInterrupt(
  ctx: AlsContext,
  toolCallId: string,
): AuthorizationSignal | undefined {
  return ctx.get(PendingToolInterruptsKey)?.[toolCallId];
}

/**
 * `setVirtualContext` is intentionally runtime-only and not on the public
 * {@link AlsContext} surface; mirror the connection-token cache and reach
 * through the concrete container (see `runtime/connections/authorization-tokens.ts`).
 */
function asContainer(ctx: AlsContext): ContextContainer {
  return ctx as ContextContainer;
}
