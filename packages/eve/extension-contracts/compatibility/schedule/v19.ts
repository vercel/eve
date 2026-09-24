import { defineChannel } from "#public/channels/index.js";
import { defineSchedule } from "#public/schedules/index.js";

const digests = defineChannel({
  routes: [],
  receive(input, { from }) {
    return from("nightly-digest").send(input.message, { auth: input.auth });
  },
});

// Epoch 19 Session.send took no operationId; epoch 20 adds it for replay-stable sends.
export default defineSchedule({
  cron: "0 2 * * *",
  async run({ to, appAuth }) {
    const session = await to(digests, {}).send("Prepare the nightly digest.", { auth: appAuth });
    await session.send("Include yesterday's incidents.", { auth: appAuth, turnPolicy: "queue" });
  },
});
