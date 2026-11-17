import type { ChannelAdapter, ChannelAdapterContext } from "#channel/adapter.js";
import type { SubagentInteractionHookPayload } from "#channel/types.js";
import { ContinuationTokenKey, SessionIdKey, SessionInboxKey } from "#context/keys.js";
import { relayedInteractionEvents } from "#harness/interaction-relay.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { SUBAGENT_ADAPTER_KIND, isSubagentAdapterState } from "#subagents/adapter-state.js";
import { createErrorId, createLogger } from "#internal/logging.js";
import { formatCapabilityError } from "#internal/capability-error.js";

const log = createLogger("execution.subagent-adapter");

export const SUBAGENT_ADAPTER: ChannelAdapter = {
  kind: SUBAGENT_ADAPTER_KIND,
  async "interaction.opened"(event, ctx) {
    await relay(event, ctx);
  },
  async "interaction.settled"(event, ctx) {
    await relay(event, ctx);
  },
  async "response.admitted"(event, ctx) {
    await relay(event, ctx);
  },
  async "response.settled"(event, ctx) {
    await relay(event, ctx);
  },
};

async function relay(event: SessionEvent, ctx: ChannelAdapterContext): Promise<void> {
  const state = ctx.state;
  if (!isSubagentAdapterState(state) || ctx.view === undefined) return;
  const childSessionId = ctx.ctx.require(SessionIdKey);
  const relayed = relayedInteractionEvents(ctx.view, event, childSessionId);
  if (relayed.length === 0) return;
  const hookPayload: SubagentInteractionHookPayload = {
    callId: state.callId,
    childSessionId,
    events: relayed,
    kind: "subagent-interaction",
    subagentName: state.subagentName,
    ...(relayed.some(
      (fact) => fact.type === "interaction.opened" && fact.data.request.kind !== "sign-in",
    ) && {
      route: {
        childContinuationToken: ctx.ctx.require(ContinuationTokenKey),
        ...(ctx.ctx.get(SessionInboxKey) !== undefined && {
          childSessionInbox: ctx.ctx.get(SessionInboxKey),
        }),
        ...(ctx.inputSource !== undefined && { inputSource: ctx.inputSource }),
      },
    }),
  };
  await forwardToParentStep({
    hookPayload,
    parentContinuationToken: state.parentContinuationToken,
  });
}

async function forwardToParentStep(input: {
  readonly hookPayload: SubagentInteractionHookPayload;
  readonly parentContinuationToken: string;
}): Promise<void> {
  "use step";

  try {
    const { resumeHook } = await import("#internal/workflow/runtime.js");
    await resumeHook(input.parentContinuationToken, input.hookPayload);
  } catch (error) {
    log.warn("failed to forward a child's interaction to its parent", {
      callId: input.hookPayload.callId,
      childSessionId: input.hookPayload.childSessionId,
      errorId: createErrorId(),
      eventTypes: input.hookPayload.events.map((fact) => fact.type),
      subagentName: input.hookPayload.subagentName,
      error: formatCapabilityError(error, [
        input.parentContinuationToken,
        input.hookPayload.route?.childContinuationToken,
      ]),
    });
    throw error;
  }
}
