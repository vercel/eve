import { timingSafeEqual } from "node:crypto";

import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import { dispatchScheduleTask } from "#internal/nitro/routes/schedule-task.js";

/**
 * Header carrying the due cron expression, kept identical to Nitro's
 * Vercel cron handler contract so one external-scheduler client can
 * drive Vercel and self-hosted deployments alike.
 */
export const EXTERNAL_CRON_SCHEDULE_HEADER = "x-vercel-cron-schedule";

/** One dispatchable schedule baked into the external cron route. */
export interface ExternalCronScheduleEntry {
  readonly cron: string;
  readonly name: string;
  readonly taskName: string;
}

/**
 * Build-time config baked into the external cron route's virtual handler.
 */
export interface ExternalCronRouteConfig {
  readonly artifactsConfig: NitroArtifactsConfig;
  readonly schedules: readonly ExternalCronScheduleEntry[];
}

/**
 * Dispatches the schedules registered for one cron expression.
 *
 * Mounted only on external-cron builds, at the same unguessable
 * per-build path the Vercel preset uses — the path is the credential.
 * The request contract also mirrors Nitro's Vercel cron handler: the
 * due cron expression arrives in {@link EXTERNAL_CRON_SCHEDULE_HEADER},
 * and when `CRON_SECRET` is set the `Authorization` header must carry
 * it as a bearer token (defense in depth on top of the path).
 */
export async function handleExternalCronRequest(
  config: ExternalCronRouteConfig,
  request: Request,
): Promise<Response> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret !== undefined && cronSecret.length > 0) {
    const authorization = request.headers.get("authorization") ?? "";
    if (!timingSafeEqualStrings(authorization, `Bearer ${cronSecret}`)) {
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    }
  }

  const cron = request.headers.get(EXTERNAL_CRON_SCHEDULE_HEADER);
  if (cron === null || cron.length === 0) {
    return Response.json(
      { error: `Missing ${EXTERNAL_CRON_SCHEDULE_HEADER} header.` },
      { status: 400 },
    );
  }

  const dueSchedules = config.schedules.filter((schedule) => schedule.cron === cron);
  const dispatched = await Promise.all(
    dueSchedules.map(async (schedule) => {
      const result = await dispatchScheduleTask(schedule.taskName, config.artifactsConfig);
      return { scheduleId: result.scheduleId, sessionIds: result.sessionIds };
    }),
  );

  return Response.json({ success: true, dispatched });
}

function timingSafeEqualStrings(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
