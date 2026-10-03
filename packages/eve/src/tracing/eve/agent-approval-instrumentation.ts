import { ROOT_CONTEXT } from "@opentelemetry/api";
import type {
  InstrumentationHandlerContext,
  InstrumentationInputRequestedEvent,
  InstrumentationInputResolvedEvent,
  InstrumentationProviderDefinition,
} from "#instrumentation/lifecycle.js";
import type { AgentActionContext } from "#tracing/eve/agent-action-instrumentation.js";
import { eveOperationInput } from "#tracing/eve/operation-input.js";
import type { DurableTraceRuntime } from "#tracing/lib/index.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import { withChannelAudience } from "#tracing/eve/channel-audience-context.js";
import type { JsonValue } from "#shared/json.js";

export function createAgentApprovalInstrumentation(input: {
  readonly lifecycle: DurableTraceRuntime;
  readonly actionContextFor: (
    sessionId: string,
    turnId: string,
    callId: string,
  ) => Promise<AgentActionContext | undefined>;
  readonly frameworkVersion: string;
}): Pick<
  NonNullable<InstrumentationProviderDefinition["events"]>,
  "input.requested" | "input.resolved"
> {
  async function onRequested(
    event: InstrumentationInputRequestedEvent,
    ctx: InstrumentationHandlerContext,
  ): Promise<void> {
    if (event.kind !== "tool-approval" || ctx.state.get() !== undefined) return;
    const parent = await input.actionContextFor(
      event.scope.sessionId,
      event.scope.turnId,
      event.action.callId,
    );
    if (parent === undefined) return;
    const operation = await input.lifecycle.approval({
      ...eveOperationInput(
        { ...event.scope, parent: parent.spanContext, frameworkVersion: input.frameworkVersion },
        event.idempotencyKey,
        parent.context,
      ),
      approval: {
        callId: event.action.callId,
        actionName: event.action.name,
        requestId: event.requestId,
        request: event.request,
      },
    });
    ctx.state.set({
      snapshot: operation.snapshot(),
      channelAudience: normalizeChannelAudience(event.scope.channelAudience),
    });
  }
  async function onResolved(
    event: InstrumentationInputResolvedEvent,
    ctx: InstrumentationHandlerContext,
  ): Promise<void> {
    const stored = ctx.state.get();
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return;
    const state = stored as Record<string, JsonValue>;
    const operation = await input.lifecycle.resume(state.snapshot, {
      context: withChannelAudience(ROOT_CONTEXT, normalizeChannelAudience(state.channelAudience)),
    });
    if (operation?.type !== "approval") return;
    if (event.outcome === "failed") await operation.fail(event.error);
    else
      await operation.complete({
        outcome: event.outcome as "approved" | "denied" | "cancelled" | "ignored" | "invalid",
        response: event.response,
      });
    ctx.state.set({
      snapshot: operation.snapshot(),
      channelAudience: normalizeChannelAudience(state.channelAudience),
    });
  }
  return { "input.requested": onRequested, "input.resolved": onResolved };
}
