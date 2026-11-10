import type {
  InstrumentationHandlerContext,
  InstrumentationInteractionKind,
  InstrumentationInteractionOpenedEvent,
  InstrumentationInteractionSettledEvent,
  InstrumentationProviderDefinition,
} from "#instrumentation/lifecycle.js";
import { resumeTool } from "#tracing/eve/agent-tool-instrumentation.js";
import type { AgentActionTraceState } from "#tracing/eve/agent-trace-state.js";
import type {
  AgentRun,
  ApprovalOperation,
  ToolOperation,
  TurnOperation,
} from "#compiled/@vercel/agent-runs/index.js";

/**
 * One `agent.approval` span for every wait on a person: an approval, a question, a budget
 * prompt, or a sign-in. It lives under the call it is about while that call is open, and under
 * the turn otherwise. Hook state keeps only the locator.
 */
export function createAgentApprovalInstrumentation(input: {
  readonly tracing: AgentRun;
  readonly actionStateFor: (
    sessionId: string,
    turnId: string,
    callId: string,
  ) => Promise<AgentActionTraceState | undefined>;
  readonly turnFor: (sessionId: string, turnId: string) => Promise<TurnOperation | undefined>;
}): Pick<
  NonNullable<InstrumentationProviderDefinition["events"]>,
  "interaction.opened" | "interaction.settled"
> {
  async function toolFor(sessionId: string, turnId: string, callId: string) {
    const state = await input.actionStateFor(sessionId, turnId, callId);
    return state === undefined ? undefined : resumeTool(input.tracing, state);
  }

  async function onOpened(
    event: InstrumentationInteractionOpenedEvent,
    ctx: InstrumentationHandlerContext,
  ): Promise<void> {
    const { call, scope } = event;
    if (scope.turnId === undefined || ctx.state.get() !== undefined) return;
    const request = {
      connectionName: event.signIn?.name,
      kind: APPROVAL_KINDS[event.kind] ?? event.kind,
      request: event.request,
      requestId: event.interactionId,
    };
    // A call without an open span here, or no call at all, leaves the wait under the turn.
    const tool =
      call === undefined ? undefined : await toolFor(scope.sessionId, scope.turnId, call.callId);
    const parent: ToolOperation | TurnOperation | undefined =
      tool ?? (await input.turnFor(scope.sessionId, scope.turnId));
    const approval = await parent?.approval(request);
    if (approval === undefined) return;
    const locator = { sessionId: scope.sessionId, turnId: scope.turnId };
    ctx.state.set(
      tool === undefined || call === undefined ? locator : { ...locator, callId: call.callId },
    );
  }

  async function onSettled(
    event: InstrumentationInteractionSettledEvent,
    ctx: InstrumentationHandlerContext,
  ): Promise<void> {
    const stored = ctx.state.get();
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return;
    const { callId, sessionId, turnId } = stored as Record<string, unknown>;
    if (typeof sessionId !== "string" || typeof turnId !== "string") return;
    const tool = typeof callId === "string" ? await toolFor(sessionId, turnId, callId) : undefined;
    const approval: ApprovalOperation | undefined =
      typeof callId === "string"
        ? tool?.findApproval(event.interactionId)
        : (await input.turnFor(sessionId, turnId))?.findApproval(event.interactionId);
    if (approval === undefined) return;
    if (event.responder !== undefined) {
      approval.attributes({
        "agent.approval.responder.type": event.responder.type,
        "agent.approval.responder.id": event.responder.id,
      });
      // The call still runs as the requester, but the tool can act for its approver.
      if (event.kind === "approval" && event.outcome === "accepted")
        tool?.attributes({
          "agent.tool.approver.type": event.responder.type,
          "agent.tool.approver.id": event.responder.id,
        });
    }
    // Other ends carry their own reasons, such as `asker-ended`; none is a refusal.
    if (event.kind === "sign-in" && event.outcome === "failed" && event.reason !== undefined)
      approval.attributes({ "agent.connection.authorization.reason": event.reason });
    if (event.outcome === "failed") await approval.fail(event.error);
    else
      await approval.complete({
        outcome: APPROVAL_OUTCOMES[event.outcome] ?? "invalid",
        response: event.answer,
      });
  }

  return { "interaction.opened": onOpened, "interaction.settled": onSettled };
}

/** `agent.approval.kind` values. A tool approval keeps the value dashboards already query. */
const APPROVAL_KINDS: Partial<Record<InstrumentationInteractionKind, string>> = {
  approval: "tool-approval",
};

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
