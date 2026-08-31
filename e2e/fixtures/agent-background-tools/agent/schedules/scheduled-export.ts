import { defineSchedule } from "eve/schedules";

import scheduleSink from "../channels/schedule-sink";

/**
 * Handler schedule used by `evals/scheduled-export.quiet-launch.eval.ts`.
 *
 * Uses a user-shaped principal to reproduce schedules that run with an
 * owner's grants. Schedule provenance must remain independent from that
 * active principal so the launch stays silent.
 */
export default defineSchedule({
  cron: "0 0 * * *",
  run({ to, waitUntil }) {
    waitUntil(
      to(scheduleSink, { id: "scheduled-export" }).send(
        "BACKGROUND-EXPORT-SCHEDULED Run the nightly export in the background.",
        {
          auth: {
            attributes: { scheduled: "true" },
            authenticator: "fixture-user",
            principalId: "scheduled-export-owner",
            principalType: "user",
          },
        },
      ),
    );
  },
});
