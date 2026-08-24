import channel from "../channel/v7.js";
import { defineSchedule } from "#public/schedules/index.js";

export default defineSchedule({
  cron: "0 9 * * 1",
  async run({ appAuth, to, waitUntil }) {
    waitUntil(
      (async () => {
        const session = await to(channel, { sessionRef: "weekly" }).send(
          "Start the weekly review",
          {
            auth: appAuth,
          },
        );
        await session.respond([{ optionId: "approve", requestId: "approval-1" }], {
          auth: appAuth,
        });
      })(),
    );
  },
});
