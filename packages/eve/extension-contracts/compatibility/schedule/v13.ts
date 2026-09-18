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
  async run({ to, waitUntil, appAuth }) {
    const session = await to(updates, {}).send("Prepare the daily summary.", { auth: appAuth });
    const result = await session.send("Include yesterday's activity.", {
      auth: appAuth,
      turnPolicy: "queue",
    });
    if (result.status === "session_not_active") return;
    waitUntil(Promise.resolve(result.sessionId));
  },
});
