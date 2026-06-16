import {
  dispatchScheduleInDev,
  UnknownDevScheduleError,
} from "#internal/nitro/host/dispatch-schedule-in-dev.js";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";

/**
 * Matches the path portion of `EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN`.
 *
 * Kept in sync with the protocol constant by construction so a future
 * prefix change touches one place. The capture group is the URL-encoded
 * schedule id; trailing path segments are intentionally rejected to keep
 * the surface narrow.
 */
const DEV_DISPATCH_SCHEDULE_PATH_PATTERN = new RegExp(
  `^${EVE_ROUTE_PREFIX.replace(/\//g, "\\/")}\\/dev\\/schedules\\/([^/]+)$`,
);

/**
 * Builds the dev-only dispatch response for one authored schedule.
 *
 * Only mounted by `configure-nitro-routes.ts` when Nitro is running in
 * dev mode — production builds never see this handler. The handler reads
 * the schedule id straight off the request URL, hands off to
 * `dispatchScheduleInDev` for the production-equivalent dispatch path,
 * and returns `{ scheduleId, sessionIds }` so callers can subscribe to
 * the existing per-session stream route for each id.
 *
 * Auth: none. The dev server is local-only and the route is dev-only.
 */
export async function handleDevScheduleDispatchRequest(
  input: { appRoot: string },
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
      appRoot: input.appRoot,
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
