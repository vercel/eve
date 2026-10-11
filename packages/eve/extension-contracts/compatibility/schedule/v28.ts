import { defineChannel } from "#public/channels/index.js";
import { defineSchedule } from "#public/schedules/index.js";

// Epoch 28 skill loads named their skill only in the action's `input`, and a
// `load-skill-result` might omit `name`; epoch 29 adds `name` to `load-skill`
// requests and requires it on results.
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
