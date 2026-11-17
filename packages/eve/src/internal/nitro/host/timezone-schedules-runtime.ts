import { Cron } from "#compiled/croner/index.js";
import { runTask } from "nitro/task";

interface TimezoneSchedule {
  readonly cron: string;
  readonly timezone: string;
  readonly nitroTaskName: string;
}

export function installTimezoneSchedules(
  app: {
    readonly ready: Promise<unknown>;
    readonly hooks: { hook(name: "close", handler: () => void): unknown };
  },
  schedules: readonly TimezoneSchedule[],
): void {
  if (process.env.TEST) return;
  const jobs: Cron[] = [];
  let closed = false;
  app.hooks.hook("close", () => {
    closed = true;
    for (const job of jobs) job.stop();
  });
  try {
    for (const schedule of schedules) {
      jobs.push(
        new Cron(schedule.cron, { timezone: schedule.timezone, unref: true }, async () => {
          try {
            await app.ready;
            if (closed) return;
            await runTask(schedule.nitroTaskName, { payload: { scheduledTime: Date.now() } });
          } catch (error) {
            console.error(`Error while running scheduled task "${schedule.nitroTaskName}"`, error);
          }
        }),
      );
    }
  } catch (error) {
    for (const job of jobs) job.stop();
    throw error;
  }
}
