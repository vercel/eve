import { defineChannel } from "#public/channels/index.js";
import { defineSchedule } from "#public/schedules/index.js";

const updates = defineChannel({
  routes: [],
  receive(input, { from }) {
    return from("daily-updates").send(input.message, { auth: input.auth });
  },
});

export default defineSchedule({
  cron: "0 9 * * *",
  async run({ to, appAuth }) {
    await to(updates, {}).send("Prepare the daily summary.", {
      auth: appAuth,
      taskDeliveryPolicy: "auto",
    });
  },
});
