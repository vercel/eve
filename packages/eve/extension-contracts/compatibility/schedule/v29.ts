import { defineChannel } from "#public/channels/index.js";
import { defineSchedule } from "#public/schedules/index.js";

// Epoch 29 sessions had no `getLineStream`; epoch 30 adds it, and channels observe each
// event after its line is written. Schedules and their channels keep working.
const reports = defineChannel({
  routes: [],
  events: {
    "actions.requested"(event) {
      console.info("report actions", { count: event.actions.length });
    },
  },
  receive(input, { from }) {
    return from("nightly-report").send(input.message, { auth: input.auth });
  },
});

export default defineSchedule({
  cron: "0 2 * * *",
  async run({ to, appAuth, waitUntil }) {
    waitUntil(to(reports, {}).send("Prepare the nightly report.", { auth: appAuth }));
  },
});
