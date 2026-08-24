import { contextStorage } from "#context/container.js";
import { AgentSessionIdKey, ChannelInstrumentationKey } from "#context/keys.js";
import { deserializeContext } from "#context/serialize.js";
import { readRootSessionId } from "#execution/eve-workflow-attributes.js";
import {
  sessionIdempotencyKey,
  type InstrumentationSessionTransitionEvent,
} from "#harness/instrumentation/lifecycle.js";
import { getInstrumentationRuntime } from "#harness/instrumentation/runtime.js";
import { instrumentationHooksForAudience } from "#harness/instrumentation/content-policy.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";

/** Publishes terminal session paths that bypass the normal harness event bridge. */
export async function publishTerminalSessionInstrumentation(input: {
  readonly error?: unknown;
  readonly serializedContext: Record<string, unknown>;
  readonly type: "session.completed" | "session.failed";
}): Promise<void> {
  const instrumentation = getInstrumentationRuntime();
  if (instrumentation === undefined) return;

  const sessionId = (input.serializedContext["eve.sessionId"] as string | undefined) ?? "";
  const rootSessionId = readRootSessionId(input.serializedContext);
  const agentSessionId =
    (input.serializedContext[AgentSessionIdKey.name] as string | undefined) ??
    rootSessionId ??
    sessionId;
  const base = {
    agentSessionId,
    idempotencyKey: sessionIdempotencyKey(sessionId),
    isRootSession: rootSessionId === undefined,
    sessionId,
  };
  const event: InstrumentationSessionTransitionEvent =
    input.type === "session.failed"
      ? { ...base, error: input.error, type: input.type }
      : { ...base, type: input.type };
  const ctx = await deserializeContext(input.serializedContext);
  const hooks = instrumentationHooksForAudience(
    instrumentation.hooks,
    normalizeChannelAudience(ctx.get(ChannelInstrumentationKey)?.metadata.audience),
  );
  if (hooks === undefined) return;
  await contextStorage.run(ctx, () => hooks.publish(event));
  await instrumentation.forceFlush();
}
