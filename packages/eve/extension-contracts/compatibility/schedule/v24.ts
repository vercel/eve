import { defineChannel } from "#public/channels/index.js";
import { defineSchedule } from "#public/schedules/index.js";

// Epoch 24 `turn.waiting` events had no `on`; epoch 25 adds it.
const reports = defineChannel({
  routes: [],
  events: {
    "turn.waiting"(event) {
      console.info("report turn waiting", { turnId: event.turnId });
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
