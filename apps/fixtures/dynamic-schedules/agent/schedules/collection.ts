import { defineScheduleCollection } from "eve/schedules";
import { vercelScheduleProvider } from "eve/schedules/vercel";
import { z } from "zod";

export default defineScheduleCollection({
  description: "Manage scheduled messages for the authenticated local user.",
  inputSchema: z.object({
    message: z.string().min(1).max(2_000),
  }),
  provider: vercelScheduleProvider({
    developmentBearerToken: process.env.EVE_TEST_ONLY_DYNAMIC_SCHEDULES_VERCEL_TOKEN,
    developmentProjectId: process.env.EVE_TEST_ONLY_DYNAMIC_SCHEDULES_VERCEL_PROJECT_ID,
  }),
  scope: "fixture",
  tools: true,
  run({ input }) {
    console.log(`[dynamic-schedules] ${input.message}`);
  },
});
