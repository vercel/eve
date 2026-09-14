import { defineSchedule } from "#public/schedules/index.js";

export default defineSchedule({
  cron: "0 0 * * *",
  markdown: "Summarize yesterday's completed work.",
});
