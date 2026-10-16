import { defineChannel } from "#public/channels/index.js";
import { defineSchedule } from "#public/schedules/index.js";

const reports = defineChannel({
  routes: [],
  receive(input, { from }) {
    return from("nightly-report").send(input.message, { auth: input.auth });
  },
});

export default defineSchedule({
  cron: "0 2 * * *",
  async run({ to, appAuth }) {
    const session = await to(reports, {}).send("Prepare the nightly report.", { auth: appAuth });
    const events = await session.getEventStream();
    const reader = events.getReader();
    const { value } = await reader.read();
    if (value?.type === "call.started") {
      const clearance = value.data.clearedBy;
      if (clearance !== undefined && "policy" in clearance) console.info(clearance.policy);
    }
    await reader.cancel();
  },
});
