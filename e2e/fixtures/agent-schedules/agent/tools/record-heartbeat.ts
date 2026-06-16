import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Tool the `heartbeat` schedule (`agent/schedules/heartbeat.ts`) instructs the
 * agent to call when the cron fires. It returns a deterministic token so the
 * schedule-dispatch eval can prove, by scanning the dispatched session's
 * stream, that the cron path actually started a session and ran the agent.
 */
export default defineTool({
  description:
    "Smoke-test fixture: records a heartbeat and returns a deterministic token. Only call when explicitly asked to use `record-heartbeat`.",
  inputSchema: z.object({
    note: z.string().min(1).describe("Any short note describing the heartbeat."),
  }),
  async execute({ note }) {
    return { ok: true, note, token: "schedule-heartbeat-ok-P2N" };
  },
});
