import { defineSchedule } from "eve/schedules";

import { SCHEDULED_REMOTE_ROOT_SCENARIO } from "../../constants";
import scheduledRemoteSink from "../channels/scheduled-remote-sink";

export default defineSchedule({
  cron: "0 0 * * *",
  run({ appAuth, to, waitUntil }) {
    waitUntil(
      to(scheduledRemoteSink, { id: "scheduled-remote" }).send(SCHEDULED_REMOTE_ROOT_SCENARIO, {
        auth: appAuth,
      }),
    );
  },
});
