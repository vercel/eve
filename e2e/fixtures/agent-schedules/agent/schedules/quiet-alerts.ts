import { defineSchedule } from "eve/schedules";

import quietSink from "../channels/quiet-sink";

export default defineSchedule({
  cron: "* * * * *",
  run({ to, waitUntil, appAuth }) {
    waitUntil(
      to(quietSink, { id: "quiet-alerts" }).send(
        [
          "Call the `check-alerts` tool exactly once with an empty object.",
          "Report the critical alerts only when the returned `alerts` list is non-empty.",
          "Do not send a message when the list is empty.",
        ].join("\n"),
        {
          auth: appAuth,
        },
      ),
    );
  },
});
