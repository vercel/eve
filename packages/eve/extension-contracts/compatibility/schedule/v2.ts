import channel from "../channel/v2.js";
import { defineSchedule } from "#public/schedules/index.js";

export default defineSchedule({
  cron: "0 0 * * *",
  async run({ appAuth, to, waitUntil }) {
    waitUntil(
      (async () => {
        const session = await to(channel, { sessionRef: "daily" }).send("Start review", {
          auth: appAuth,
        });
        await session.respond([{ optionId: "approve", requestId: "approval-1" }], {
          auth: appAuth,
        });
      })(),
    );
  },
});
