import { defineDynamic, defineRemoteSubagent } from "eve";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineRemoteSubagent({
        background: true,
        description: "Loopback remote child for deterministic task HITL coverage.",
        url: () =>
          process.env.VERCEL_URL !== undefined && process.env.VERCEL_URL !== ""
            ? `https://${process.env.VERCEL_URL}`
            : (process.env.WORKFLOW_LOCAL_BASE_URL ?? "http://127.0.0.1:3000"),
        headers: () => {
          const headers: Record<string, string> = {
            authorization: "Bearer e2e-task-remote-loopback",
          };
          const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
          if (bypass !== undefined && bypass !== "") {
            headers["x-vercel-protection-bypass"] = bypass;
          }
          return headers;
        },
      }),
  },
});
