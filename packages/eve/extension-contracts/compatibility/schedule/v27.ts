import { defineChannel } from "#public/channels/index.js";
import { defineSchedule } from "#public/schedules/index.js";

// Epoch 27 tool-call action requests could carry `parentCallId` for nested
// actions; epoch 28 drops it, since connection tools no longer report them.
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
