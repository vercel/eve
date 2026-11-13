import { storedTurnPolicy, type TurnMode, type TurnPolicy } from "#channel/types.js";

export function parseTurnPolicyField(value: unknown): TurnMode | Response | undefined {
  if (value === undefined) return undefined;
  if (value === "queue" || value === "steer") return value;
  return Response.json(
    { error: "Expected 'turnPolicy' to be either 'queue' or 'steer'.", ok: false },
    { status: 400 },
  );
}

/**
 * The policy for a message whose request chose `mode`. A request chooses only whether the message
 * steers or queues. `principal` decides whose access a message can reach, so it comes from the
 * channel's own policy, and only when that policy steers.
 */
export function turnPolicyForRequest(
  mode: TurnMode | undefined,
  channelPolicy: TurnPolicy | undefined,
): TurnPolicy | undefined {
  if (mode !== "steer" || channelPolicy === undefined) return mode;
  return storedTurnPolicy(channelPolicy).turnPolicy === "steer" ? channelPolicy : mode;
}
