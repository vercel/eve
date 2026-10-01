import { defineChannel } from "#public/channels/index.js";
import { defineSchedule } from "#public/schedules/index.js";

// Existing callbacks remain valid when message.received carries clientContext.
const reports = defineChannel({
  routes: [],
  events: {
    "task.settled"(event) {
      console.info("report task settled", { status: event.status, taskId: event.taskId });
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
