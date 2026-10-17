// Epoch 33 had no `decline` on input responses or `declined` input outcome; epoch 34 adds
// them as optional. Authoring code that never uses them keeps working.
import { defineChannel } from "#public/channels/index.js";
import { defineSchedule } from "#public/schedules/index.js";

// Epoch 32 `action.result` errors had no `name`; epoch 33 adds it as optional.
const reports = defineChannel({
  routes: [],
  receive(input, { from }) {
    return from("nightly-report").send(input.message, { auth: input.auth });
  },
});

export default defineSchedule({
  cron: "0 2 * * *",
  async run({ to, appAuth, waitUntil }) {
    const session = await to(reports, {}).send("Prepare the nightly report.", { auth: appAuth });
    const events = await session.getEventStream({ startIndex: 0 });
    waitUntil(events.cancel());
  },
});
