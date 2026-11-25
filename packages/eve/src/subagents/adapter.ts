import type { ChannelAdapter, ChannelAdapterContext } from "#channel/adapter.js";
import type { SubagentInteractionHookPayload } from "#channel/types.js";
import { ContinuationTokenKey, SessionIdKey, SessionInboxKey } from "#context/keys.js";
import { relayedInteractionEvents } from "#harness/interaction-relay.js";
import type { SessionEvent } from "#protocol/session-event.js";
import {
  isDirectSubagentTaskRef,
  SUBAGENT_ADAPTER_KIND,
  isSubagentAdapterState,
} from "#subagents/adapter-state.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
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
  const directTask = isDirectSubagentTaskRef(state.directTask) ? state.directTask : undefined;
  const payload: SubagentInteractionHookPayload | WorkflowToolRunMessage =
    directTask === undefined
      ? hookPayload
      : {
          from: {
            callId: state.callId,
            input: {},
            runId: childSessionId,
            sequence: directTask.sequence,
            stepIndex: directTask.stepIndex,
            taskId: directTask.taskId,
            toolName: directTask.toolName,
            turnId: directTask.turnId,
          },
          kind: "request",
          replyTo: "",
          request: { event: hookPayload, kind: "relay" },
        };
  await forwardToParentStep({
    callId: hookPayload.callId,
    childContinuationToken: hookPayload.route?.childContinuationToken,
    childSessionId: hookPayload.childSessionId,
    eventTypes: hookPayload.events.map((fact) => fact.type),
    payload,
    parentContinuationToken: state.parentContinuationToken,
    subagentName: hookPayload.subagentName,
  });
}

async function forwardToParentStep(input: {
  readonly callId: string;
  readonly childContinuationToken?: string;
  readonly childSessionId: string;
  readonly eventTypes: readonly string[];
  readonly payload: SubagentInteractionHookPayload | WorkflowToolRunMessage;
  readonly parentContinuationToken: string;
  readonly subagentName: string;
}): Promise<void> {
  "use step";

  try {
    const { resumeRoutedHook } = await import("#execution/hosts.js");
    await resumeRoutedHook(input.parentContinuationToken, input.payload);
  } catch (error) {
    log.warn("failed to forward a child's interaction to its parent", {
      callId: input.callId,
      childSessionId: input.childSessionId,
      errorId: createErrorId(),
      eventTypes: input.eventTypes,
      subagentName: input.subagentName,
      error: formatCapabilityError(error, [
        input.parentContinuationToken,
        input.childContinuationToken,
      ]),
    });
    throw error;
  }
}
