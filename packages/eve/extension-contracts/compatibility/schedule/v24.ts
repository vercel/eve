import { defineChannel } from "#public/channels/index.js";
import { defineSchedule } from "#public/schedules/index.js";

// Epoch 24 channels had no `task.activity` event; epoch 25 adds it.
const reports = defineChannel({
  routes: [],
  events: {
    "task.started"(event) {
      console.info("report task started", { name: event.name, taskId: event.taskId });
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
