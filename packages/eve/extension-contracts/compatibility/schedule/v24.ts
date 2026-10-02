import { defineChannel } from "#public/channels/index.js";
import { defineSchedule } from "#public/schedules/index.js";

// Epoch 24 `session.waiting`, `session.failed`, `session.completed`, and `turn.waiting` events had no `usage`; epoch 25 adds it as optional.
const reports = defineChannel({
  routes: [],
  events: {
    "session.waiting"(event) {
      console.info("report waiting", { continuationToken: event.continuationToken });
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
