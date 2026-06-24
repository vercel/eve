import { defineSchedule } from "eve/schedules";

import quietSink from "../channels/quiet-sink.js";

export default defineSchedule({
  cron: "* * * * *",
  run({ receive, waitUntil, appAuth }) {
    waitUntil(
      receive(quietSink, {
        auth: appAuth,
        message: [
          "Call the `check-alerts` tool exactly once with an empty object.",
          "Report the critical alerts only when the returned `alerts` list is non-empty.",
          "If the list is empty, finish without any text.",
        ].join("\n"),
        target: { id: "quiet-alerts" },
      }),
    );
  },
});
