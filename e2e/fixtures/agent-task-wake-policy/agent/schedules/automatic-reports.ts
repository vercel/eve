import { defineSchedule } from "eve/schedules";
import reports from "../channels/scheduled-reports";

export default defineSchedule({
  cron: "0 9 * * *",
  run({ to, waitUntil, appAuth }) {
    waitUntil(
      to(reports, { id: crypto.randomUUID() }).send(
        "Alice asks Bob to prepare reports A, B, and C. Report A is independent; reports B and C form a joint comparison. Share A when ready and combine B with C once both are available.",
        { auth: appAuth, taskDeliveryPolicy: "auto" },
      ),
    );
  },
});
