import { z } from "zod";

import { defineScheduleCollection } from "#public/schedules/index.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";

export default defineScheduleCollection({
  description: "Run saved queries.",
  payloadSchema: z.object({ query: z.string() }),
  provider: inMemoryScheduleProvider(),
  scope: () => "queries",
  tools: true,
  async run({ input, occurrence }) {
    input.query.toUpperCase();
    occurrence.executionId.toUpperCase();
  },
});
