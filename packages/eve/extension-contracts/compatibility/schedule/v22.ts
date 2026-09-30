import { defineChannel } from "#public/channels/index.js";
import { defineSchedule } from "#public/schedules/index.js";

// Epoch 22 schedules had no `isScheduleAuth` export; epoch 23 adds it.
// Schedules that pass `appAuth` through keep working.
const digest = defineChannel({
  routes: [],
  receive(input, { from }) {
    return from("weekly-digest").send(input.message, { auth: input.auth });
  },
});

export default defineSchedule({
  cron: "0 8 * * 1",
  async run({ to, appAuth, waitUntil }) {
    waitUntil(to(digest, {}).send("Prepare the weekly digest.", { auth: appAuth }));
  },
});
