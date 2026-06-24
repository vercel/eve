import { defineSchedule } from "eve/schedules";

export default defineSchedule({
  cron: "* * * * *",
  markdown: [
    "Call the `check-alerts` tool exactly once with an empty object.",
    "Report the critical alerts only when the returned `alerts` list is non-empty.",
    "If the list is empty, finish without any text.",
  ].join("\n"),
});
