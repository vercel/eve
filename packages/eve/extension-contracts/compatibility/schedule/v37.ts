import { defineChannel } from "#public/channels/index.js";
import { defineSchedule, isScheduleAuth } from "#public/schedules/index.js";

const reports = defineChannel({
  routes: [],
  receive(input, { from }) {
    return from("reports").send(input.message, { auth: input.auth });
  },
});

export default defineSchedule({
  cron: "0 9 * * 1-5",
  async run({ to, appAuth }) {
    if (!isScheduleAuth(appAuth)) throw new Error("Expected schedule auth.");
    await to(reports, {}).send("Prepare Alice's daily report.", { auth: appAuth });
  },
});
