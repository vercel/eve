import { defineTool } from "eve/tools";
import { z } from "zod";
import extension from "../extension.js";
import { owned } from "../lib/config.js";
import { store } from "../lib/store.js";
import type { Experiment } from "../lib/types.js";

/** Shows private findings, experiments, and verification state to the authenticated configured owner. */
export default defineTool({
  description:
    "Inspect the private self-improvement ledger, pending PR/head, verification and next action. Configured owner only.",
  availableInSubagents: false,
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const c = extension.config;
    if (!owned(c, ctx.session.auth.current))
      throw new Error("Only the configured authenticated owner can read the evolution ledger");
    const db = store(c),
      active = await db.active();
    const concise = (e: Experiment) => ({
      id: e.id,
      status: e.status,
      finding: e.finding,
      candidate: e.candidate,
      reason: e.reason,
      checks: e.checks,
      release: e.release,
    });
    return {
      mode: c.policy.mode,
      cronUtc: c.cron,
      active: active?.experiment ? concise(active.experiment) : null,
      recent: (await db.list<Experiment>("experiment:", 30)).map(concise),
    };
  },
});
