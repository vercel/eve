import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    "session.started"(_event, ctx) {
      ctx.registerAgent({
        key: "startup-directory-agent",
        description: "A directory destination with unknown reachability.",
        target: { kind: "remote", url: "https://offline.example.invalid" },
      });
    },
  },
});
