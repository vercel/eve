import { defineChannel } from "#public/channels/index.js";
import { defineSchedule } from "#public/schedules/index.js";

const digests = defineChannel({
  routes: [],
  receive(input, { from }) {
    return from("nightly-digest").send(input.message, { auth: input.auth });
  },
});

// Epoch 18 Session.cancel accepted only turnId; epoch 19 adds taskId and tasks.
export default defineSchedule({
  cron: "0 2 * * *",
  async run({ to, appAuth }) {
    const session = await to(digests, {}).send("Prepare the nightly digest.", { auth: appAuth });
    await session.cancel();
  },
});
