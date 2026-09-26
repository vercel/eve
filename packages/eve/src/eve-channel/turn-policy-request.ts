import type { TurnPolicy } from "#channel/types.js";

export function parseTurnPolicyField(value: unknown): TurnPolicy | Response | undefined {
  if (value === undefined) return undefined;
  if (value === "queue" || value === "steer") return value;
  return Response.json(
    { error: "Expected 'turnPolicy' to be either 'queue' or 'steer'.", ok: false },
    { status: 400 },
  );
}
