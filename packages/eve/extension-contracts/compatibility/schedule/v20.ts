import { defineChannel } from "#public/channels/index.js";
import { defineSchedule } from "#public/schedules/index.js";

const digests = defineChannel({
  routes: [],
  receive(input, { from }) {
    return from("nightly-digest").send(input.message, { auth: input.auth });
  },
});

// Epoch 20 approval events carried no taskId; epoch 21 adds it for approvals
// proxied from a child task. Schedule options and Session.send are unchanged.
export default defineSchedule({
  cron: "0 2 * * *",
  async run({ to, appAuth }) {
    const session = await to(digests, {}).send("Prepare the nightly digest.", { auth: appAuth });
    await session.send("Include yesterday's incidents.", {
      auth: appAuth,
      operationId: "nightly-digest-incidents",
      turnPolicy: "queue",
    });
  },
});
