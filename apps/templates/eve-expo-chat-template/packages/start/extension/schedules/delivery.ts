import { defineSchedule } from "eve/schedules";
import { config, appOrigin } from "../../src/config.ts";
import { createHash } from "node:crypto";
export default defineSchedule({
  cron: "* * * * *",
  async run() {
    const origin = appOrigin();
    const token = config().agentToken;
    if (!origin || !token) return;
    const response = await fetch(new URL("/start/tick", origin), {
      method: "POST",
      headers: {
        Authorization:
          "Bearer " +
          createHash("sha256")
            .update("eve-start-wake:" + token)
            .digest("hex"),
        ...(config().appBypassToken
          ? { "x-vercel-protection-bypass": config().appBypassToken }
          : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(260000),
    });
    if (!response.ok) throw Error(`eve Start delivery returned ${response.status}`);
    await response.body?.cancel();
  },
});
