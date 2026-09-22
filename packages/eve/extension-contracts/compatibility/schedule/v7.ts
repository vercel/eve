import { defineSchedule } from "#public/schedules/index.js";

export default defineSchedule({
  cron: "0 0 * * *",
  run({ waitUntil }) {
    waitUntil(Promise.resolve());
  },
});
