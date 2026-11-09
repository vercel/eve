import { CHANNEL_CONTEXT_KEY_NAME } from "#context/key-names.js";
import { publishSessionEvents, type SessionStepState } from "#execution/publish-session-events.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import type { ControlDelivery } from "#harness/types.js";
import { settleControl } from "#harness/session-machine/deliveries.js";
import type { JsonObject } from "#shared/json.js";

interface SerializedChannel {
  readonly kind: string;
  readonly state?: Record<string, unknown>;
}

/**
 * Shallow-merges a `channel-state` control's patch into the channel adapter's state, and settles
 * its delivery. It touches only the adapter's state, never the turn or its auth, so an active
 * turn's next step reads the patch.
 */
export async function patchChannelStateStep(
  input: SessionStepState & { readonly control: ControlDelivery; readonly patch: JsonObject },
) {
  "use step";
  return await withSessionStateDelta(input, async (step) => {
    const channel = step.serializedContext[CHANNEL_CONTEXT_KEY_NAME] as
      | SerializedChannel
      | undefined;
    if (channel === undefined) {
      return await publishSessionEvents(step, [
        settleControl({
          control: input.control,
          outcome: "failed",
          reason: "The session has no channel state.",
          source: "channel-state",
        }),
      ]);
    }
    const serializedContext = {
      ...step.serializedContext,
      [CHANNEL_CONTEXT_KEY_NAME]: { ...channel, state: { ...channel.state, ...input.patch } },
    };
    return await publishSessionEvents({ ...step, serializedContext }, [
      settleControl({ control: input.control, outcome: "applied", source: "channel-state" }),
    ]);
  });
}
