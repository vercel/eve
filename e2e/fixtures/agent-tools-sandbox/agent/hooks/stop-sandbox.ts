import { defineHook } from "eve/hooks";

const STOP_SANDBOX_TOKEN = "sandbox-stop-hook-ready-R7V";
const STOP_SANDBOX_MARKER_PATH = "/workspace/stopped-by-hook.txt";

export default defineHook({
  events: {
    async "message.completed"(event, ctx) {
      if (!event.data.message?.includes(STOP_SANDBOX_TOKEN)) return;

      const sandbox = await ctx.getSandbox();
      await sandbox.writeTextFile({
        content: STOP_SANDBOX_TOKEN,
        path: STOP_SANDBOX_MARKER_PATH,
      });
      await sandbox.stop();
    },
  },
});
