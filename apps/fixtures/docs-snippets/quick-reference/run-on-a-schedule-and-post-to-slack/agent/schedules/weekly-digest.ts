import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack";

export default defineSchedule({
  cron: "0 15 * * 1", // Mondays at 15:00 UTC
  async run({ to, waitUntil, appAuth }) {
    waitUntil(
      to(slack, { channelId: "C0123ABC" }).send("Post this week's metrics summary.", {
        auth: appAuth,
      }),
    );
  },
});
