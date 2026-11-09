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
 * Applies a `channel-state` control's patch to the channel adapter's state as a JSON merge patch
 * (RFC 7386), and settles its delivery. It touches only the adapter's state, never the turn or its
 * auth, so an active turn's next step reads the patch.
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
      [CHANNEL_CONTEXT_KEY_NAME]: {
        ...channel,
        state: mergePatch(channel.state ?? {}, input.patch),
      },
    };
    return await publishSessionEvents({ ...step, serializedContext }, [
      settleControl({ control: input.control, outcome: "applied", source: "channel-state" }),
    ]);
  });
}

/**
 * RFC 7386: an object in the patch merges into the target's object at that key, `null` removes the
 * key, and any other value replaces it. Patches for different keys of one map therefore compose.
 */
function mergePatch(target: Record<string, unknown>, patch: JsonObject): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
    } else if (isPlainObject(value)) {
      const current = merged[key];
      merged[key] = mergePatch(isPlainObject(current) ? current : {}, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
