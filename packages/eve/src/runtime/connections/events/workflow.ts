import { createHook } from "#compiled/@workflow/core/index.js";
import {
  claimHookOwnership,
  disposeHook,
  isHookConflictError,
  isHookForceClaimedError,
} from "#execution/hook-ownership.js";
import type { ConnectionEventPayload } from "#runtime/connections/events/delivery.js";
import {
  connectionEventHandoverToken,
  connectionEventHookToken,
} from "#runtime/connections/events/path.js";
import {
  eventOwner,
  type ConnectionEventHandlerState,
  type ConnectionEventHandover,
  type EventBinding,
} from "#runtime/connections/events/state.js";
import { dispatchConnectionEventStep } from "#runtime/connections/events/dispatch-step.js";
import {
  openConnectionEventStep,
  passConnectionEventHandoverStep,
  publishConnectionEventOutcomeStep,
  startConnectionEventSuccessorStep,
} from "#runtime/connections/events/lifecycle-step.js";

export type ConnectionEventMessage = ConnectionEventPayload | { readonly kind: "retire" };

/**
 * Every resume replays the run's whole log, about four entries per delivery.
 * Handing over well before Workflow's replay slowdown (2,000 entries) keeps
 * each resume short and each run far below the 25,000-entry cap.
 */
export const CONNECTION_EVENT_HANDOVER_DELIVERIES = 250;

/**
 * How long an ended watch stays findable by its id, so get and a repeated
 * stop still reach Connect while it finishes upstream cleanup.
 */
export const ENDED_WATCH_RETENTION = "7d";

/**
 * Holds one watch: its binding, subscription and receipts live only in this
 * run and its successors. After {@link CONNECTION_EVENT_HANDOVER_DELIVERIES}
 * deliveries it starts a successor, which takes the hook; this run processes
 * every delivery it received before the takeover, then sends the successor its
 * final state.
 */
export async function connectionEventWorkflow(input: {
  readonly binding: EventBinding;
  readonly serializedContext: Record<string, unknown>;
  /** Set on a successor: how many runs held this watch before it. */
  readonly generation?: number;
}): Promise<void> {
  "use workflow";
  const generation = input.generation ?? 0;
  const token = connectionEventHookToken(input.binding.id);
  // A successor registers where its predecessor will send the final state
  // before it takes the watch hook, so that send always finds it.
  const inbound =
    generation === 0
      ? undefined
      : createHook<ConnectionEventHandover>({
          token: connectionEventHandoverToken(input.binding.id, generation),
        });
  if (inbound !== undefined) await claimHookOwnership(inbound);
  const hook = createHook<ConnectionEventMessage>({
    token,
    metadata: eventOwner(input.binding),
    // Every delivery after the takeover reaches this run, without a gap.
    experimental_force: generation > 0,
  });
  try {
    await claimHookOwnership(hook);
  } catch (error) {
    if (!isHookConflictError(error) || typeof error.conflictingRunId !== "string") throw error;
    // A retried subscribing tool started a second run: its caller reads the first one.
    await publishConnectionEventOutcomeStep({ ownerRunId: error.conflictingRunId });
    return;
  }
  let serializedContext = input.serializedContext;
  let state: ConnectionEventHandlerState;
  let deliveries = 0;
  let handedOver = false;
  let ended = false;
  try {
    if (inbound === undefined) {
      const opened = await openConnectionEventStep({ serializedContext, binding: input.binding });
      if ("error" in opened) return;
      state = { binding: input.binding, subscription: opened.subscription, receipts: [] };
    } else {
      const carried = await inbound;
      await disposeHook(inbound);
      serializedContext = carried.serializedContext;
      state = carried.state;
      ended = carried.ended;
      // Get and stop read the subscription from whichever run holds the token.
      await publishConnectionEventOutcomeStep({ subscription: state.subscription });
    }
    try {
      if (!ended)
        for await (const message of hook) {
          // A stopped watch ignores the rest; after a handover it waits for the takeover.
          if (ended) continue;
          if (message.kind === "retire") ended = true;
          else {
            const dispatched = await dispatchConnectionEventStep({
              serializedContext,
              state,
              payload: message,
            });
            serializedContext = dispatched.serializedContext;
            state = dispatched.state;
            ended =
              dispatched.accepted &&
              "control" in message.delivery &&
              message.delivery.control.type === "terminated";
            if (++deliveries === CONNECTION_EVENT_HANDOVER_DELIVERIES && !ended) {
              await startConnectionEventSuccessorStep({
                serializedContext,
                binding: state.binding,
                generation: generation + 1,
              });
              handedOver = true;
            }
          }
          if (ended && !handedOver) break;
        }
    } catch (error) {
      // Only this watch's next generation forces its token.
      if (!isHookForceClaimedError(error)) throw error;
      await passConnectionEventHandoverStep({
        bindingId: input.binding.id,
        generation: generation + 1,
        handover: { serializedContext, state, ended },
      });
      return;
    }
    await disposeHook(hook);
    // The ended watch stays addressable without a registry: this finished run
    // keeps its token, and its subscription stays readable from its stream.
    await claimHookOwnership(
      createHook<ConnectionEventMessage>({
        token,
        metadata: eventOwner(input.binding),
        experimental_minRetention: ENDED_WATCH_RETENTION,
      }),
    );
  } finally {
    await disposeHook(hook);
  }
}
