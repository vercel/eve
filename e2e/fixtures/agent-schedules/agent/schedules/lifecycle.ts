import { defineSchedule } from "eve/schedules";

import { lifecycleState } from "../lib/lifecycle-state";

export default defineSchedule({
  cron: "0 0 1 1 *",
  run({ waitUntil }) {
    waitUntil(
      new Promise<void>((resolve) => {
        setTimeout(() => {
          lifecycleState.completed++;
          resolve();
        }, 10);
      }),
    );
  },
});
