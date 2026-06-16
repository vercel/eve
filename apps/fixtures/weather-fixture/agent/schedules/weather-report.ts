import { defineSchedule } from "eve/schedules";

import slack from "../channels/slack.js";

export default defineSchedule({
  cron: "*/5 * * * *",
  async run({ receive, waitUntil, appAuth }) {
    waitUntil(
      receive(slack, {
        message: "Whats the temp in NYC?",
        target: { channelId: "C0123ABC" },
        auth: appAuth,
      }),
    );
  },
});
