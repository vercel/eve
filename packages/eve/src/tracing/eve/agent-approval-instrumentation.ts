import type {
  InstrumentationHandlerContext,
  InstrumentationInteractionOpenedEvent,
  InstrumentationInteractionSettledEvent,
  InstrumentationProviderDefinition,
} from "#instrumentation/lifecycle.js";
import { resumeTool } from "#tracing/eve/agent-tool-instrumentation.js";
import type { AgentActionTraceState } from "#tracing/eve/agent-trace-state.js";
import type { AgentRun } from "#compiled/@vercel/agent-runs/index.js";

/** Approval spans live under their tool call; hook state keeps only the locator. */
export function createAgentApprovalInstrumentation(input: {
  readonly tracing: AgentRun;
  readonly actionStateFor: (
    sessionId: string,
    turnId: string,
    callId: string,
  ) => Promise<AgentActionTraceState | undefined>;
}): Pick<
  NonNullable<InstrumentationProviderDefinition["events"]>,
  "interaction.opened" | "interaction.settled"
> {
  async function toolFor(sessionId: string, turnId: string, callId: string) {
    const state = await input.actionStateFor(sessionId, turnId, callId);
    return state === undefined ? undefined : resumeTool(input.tracing, state);
  }

  async function onRequested(
    event: InstrumentationInteractionOpenedEvent,
    ctx: InstrumentationHandlerContext,
  ): Promise<void> {
    const { call } = event;
    if (event.scope.turnId === undefined) return;
    if (event.kind !== "approval" || call === undefined || ctx.state.get() !== undefined) return;
    const tool = await toolFor(event.scope.sessionId, event.scope.turnId, call.callId);
    const approval = await tool?.approval({
      requestId: event.interactionId,
      request: event.request,
    });
    if (approval === undefined) return;
    ctx.state.set({
      callId: call.callId,
      sessionId: event.scope.sessionId,
      turnId: event.scope.turnId,
    });
  }

  async function onResolved(
    event: InstrumentationInteractionSettledEvent,
    ctx: InstrumentationHandlerContext,
  ): Promise<void> {
    const stored = ctx.state.get();
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return;
    const { callId, sessionId, turnId } = stored as Record<string, unknown>;
    if (typeof callId !== "string" || typeof sessionId !== "string" || typeof turnId !== "string")
      return;
    const approval = (await toolFor(sessionId, turnId, callId))?.findApproval(event.interactionId);
    if (approval === undefined) return;
    if (event.outcome === "failed") await approval.fail(event.error);
    else
      await approval.complete({
        outcome: APPROVAL_OUTCOMES[event.outcome] ?? "invalid",
        response: event.answer,
      });
  }

  return { "interaction.opened": onRequested, "interaction.settled": onResolved };
}

/**
 * Trace schema 4's approval outcomes. The instrumentation event carries the interaction's
 * outcome; the span keeps the values dashboards already query.
 */
const APPROVAL_OUTCOMES: Partial<
  Record<
    InstrumentationInteractionSettledEvent["outcome"],
    "approved" | "denied" | "cancelled" | "ignored" | "invalid"
  >
> = {
  abandoned: "cancelled",
  accepted: "approved",
  declined: "denied",
  expired: "cancelled",
  interrupted: "cancelled",
  withdrawn: "ignored",
};
