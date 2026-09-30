import { defineChannel } from "#public/channels/index.js";
import { defineSchedule } from "#public/schedules/index.js";

// Epoch 19 stream events had no `meta.index`; it is optional and additive.
const updates = defineChannel({
  routes: [],
  events: {
    "message.completed"(event) {
      console.info("summary ready", { turnId: event.turnId });
    },
  },
  receive(input, { from }) {
    return from("daily-updates").send(input.message, { auth: input.auth });
  },
});

export default defineSchedule({
  cron: "0 9 * * *",
  async run({ to, appAuth }) {
    await to(updates, {}).send("Prepare the daily summary.", { auth: appAuth });
  },
});
