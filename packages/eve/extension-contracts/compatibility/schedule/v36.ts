// Retained schedule epoch 36: existing authoring works with proactive session preparation.
import { defineChannel } from "#public/channels/index.js";
import { defineSchedule } from "#public/schedules/index.js";

const reports = defineChannel({
  routes: [],
  receive(input, { from }) {
    return from("reports").send(input.message, { auth: input.auth });
  },
});

export default defineSchedule({
  cron: "0 2 * * *",
  async run({ to, appAuth }) {
    const session = await to(reports, {}).send("Prepare Alice's report.", { auth: appAuth });
    await session.send("Include Bob's notes.", {
      auth: appAuth,
      history: [{ role: "user", text: "Bob reviewed the earlier draft." }],
    });
  },
});
