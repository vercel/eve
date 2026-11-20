import { storedTurnPolicy, type TurnMode, type TurnPolicy } from "#channel/types.js";

export function parseTurnPolicyField(value: unknown): TurnMode | Response | undefined {
  if (value === undefined) return undefined;
  if (value === "queue" || value === "steer") return value;
  return Response.json(
    { error: "Expected 'turnPolicy' to be either 'queue' or 'steer'.", ok: false },
    { status: 400 },
  );
}

export function turnPolicyForRequest(
  mode: TurnMode | undefined,
  channelPolicy: TurnPolicy | undefined,
): TurnPolicy | undefined {
  if (mode !== "steer" || channelPolicy === undefined) return mode;
  return storedTurnPolicy(channelPolicy).turnPolicy === "steer" ? channelPolicy : mode;
}
