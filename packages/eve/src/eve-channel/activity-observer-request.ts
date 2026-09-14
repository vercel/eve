import { parseActivitySink } from "#channel/activity-sink.js";
import type { ActivityObserverConfig, SessionCallback } from "#channel/types.js";
import { parseActivityWorkIdentityV1 } from "#protocol/activity.js";

type BoundActivityObserverConfig = ActivityObserverConfig & {
  readonly workIdentity: NonNullable<ActivityObserverConfig["workIdentity"]>;
};

export function parseActivityObserverField(
  value: unknown,
): BoundActivityObserverConfig | Response | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") {
    return invalidActivityObserver();
  }
  try {
    const sink = parseActivitySink(Reflect.get(value, "sink"));
    const workIdentity = parseActivityWorkIdentityV1(Reflect.get(value, "workIdentity"));
    if (sink === undefined || workIdentity === undefined) {
      return invalidActivityObserver();
    }
    return { sink, workIdentity };
  } catch (error) {
    return invalidActivityObserver(
      error instanceof Error ? error.message : "Invalid activity observer configuration.",
    );
  }
}

export function validateActivityObserverBinding(
  activityObserver: BoundActivityObserverConfig,
  callback: SessionCallback | undefined,
): Response | undefined {
  if (callback === undefined) {
    return invalidBinding("Activity observer configuration requires a delegated session callback.");
  }
  if (activityObserver.workIdentity.callId !== callback.callId) {
    return invalidBinding("Activity observer callId must match the delegated session callback.");
  }
  if (activityObserver.workIdentity.name !== callback.subagentName) {
    return invalidBinding("Activity observer name must match the delegated session callback.");
  }
  if (new URL(activityObserver.sink.url).origin !== new URL(callback.url).origin) {
    return invalidBinding("Activity observer sink must share the delegated callback origin.");
  }
  return undefined;
}

function invalidActivityObserver(error = "Invalid activity observer configuration."): Response {
  return Response.json({ error, ok: false }, { status: 400 });
}

function invalidBinding(error: string): Response {
  return Response.json({ error, ok: false }, { status: 400 });
}
