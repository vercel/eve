import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack";

export default defineSchedule({
  cron: "0 8 1 * *", // 08:00 UTC on the first of each month
  async run({ to, waitUntil, appAuth }) {
    waitUntil(
      to(slack, { channelId: "C0123ABC" }).send("Recap the projects that shipped last month.", {
        auth: appAuth,
      }),
    );
  },
});
