import type { UserContent } from "ai";
import type { TaskDeliveryPolicy, TurnPolicy } from "#channel/types.js";

export function parseTaskDeliveryPolicyField(
  value: unknown,
  message: string | UserContent | undefined,
): TaskDeliveryPolicy | undefined | Response {
  if (value === undefined) return undefined;
  if (value !== "auto" && value !== "cohort") {
    return Response.json(
      { error: "Expected 'taskDeliveryPolicy' to be either 'auto' or 'cohort'.", ok: false },
      { status: 400 },
    );
  }
  if (message === undefined) {
    return Response.json(
      { error: "'taskDeliveryPolicy' requires a non-empty 'message'.", ok: false },
      { status: 400 },
    );
  }
  return value;
}

export function parseTurnPolicyField(value: unknown): TurnPolicy | Response | undefined {
  if (value === undefined) return undefined;
  if (value === "queue" || value === "steer") return value;
  return Response.json(
    { error: "Expected 'turnPolicy' to be either 'queue' or 'steer'.", ok: false },
    { status: 400 },
  );
}
