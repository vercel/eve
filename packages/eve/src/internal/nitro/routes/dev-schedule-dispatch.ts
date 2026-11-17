import {
  dispatchScheduleInDev,
  UnknownDevScheduleError,
} from "#internal/nitro/host/dispatch-schedule-in-dev.js";
import type { DevelopmentNitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";

const DEV_DISPATCH_SCHEDULE_PATH_PATTERN = new RegExp(
  `^${EVE_ROUTE_PREFIX.replace(/\//g, "\\/")}\\/dev\\/schedules\\/([^/]+)$`,
);

export async function handleDevScheduleDispatchRequest(
  input: DevelopmentNitroArtifactsConfig,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(DEV_DISPATCH_SCHEDULE_PATH_PATTERN);
  const encodedScheduleId = match?.[1];
  if (typeof encodedScheduleId !== "string" || encodedScheduleId.length === 0) {
    return Response.json({ error: "Missing schedule id." }, { status: 400 });
  }

  let scheduleId: string;
  try {
    scheduleId = decodeURIComponent(encodedScheduleId);
  } catch {
    return Response.json({ error: "Schedule id is not a valid URI component." }, { status: 400 });
  }

  if (scheduleId.length === 0) {
    return Response.json({ error: "Missing schedule id." }, { status: 400 });
  }

  try {
    const result = await dispatchScheduleInDev({
      artifactsConfig: input,
      scheduleId,
    });
    return Response.json({
      scheduleId: result.scheduleId,
      sessionIds: result.sessionIds,
    });
  } catch (error) {
    if (error instanceof UnknownDevScheduleError) {
      return Response.json(
        {
          error: error.message,
          availableScheduleIds: error.availableScheduleIds,
        },
        { status: 404 },
      );
    }
    throw error;
  }
}
