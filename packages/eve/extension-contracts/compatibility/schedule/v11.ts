import { defineSchedule } from "#public/schedules/index.js";

export default defineSchedule({
  cron: "0 9 * * *",
  run({ waitUntil, appAuth }) {
    waitUntil(Promise.resolve(appAuth.principalId));
  },
});
