import { defineChannel } from "#public/channels/index.js";
import { defineSchedule } from "#public/schedules/index.js";

// Epoch 34 changes types a schedule reaches through the session context, as dynamic values and
// hooks move to select, record, render, and run. Sending to a channel on a cron doesn't change.
const reports = defineChannel({
  routes: [],
  receive(input, { from }) {
    return from("nightly-report").send(input.message, { auth: input.auth });
  },
});

export default defineSchedule({
  cron: "0 2 * * *",
  async run({ to, appAuth }) {
    await to(reports, {}).send("Prepare the nightly report.", { auth: appAuth });
  },
});
