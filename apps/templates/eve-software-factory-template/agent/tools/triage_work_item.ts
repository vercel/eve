import { defineTool } from "eve/tools";
import { z } from "zod";
import { triageWorkItem } from "../lib/triage/decisions.js";

/** Decisions have no side effects; apply labels through the gated GitHub tools. */
export default defineTool({
  description:
    "Triage a work item in one decision-model call. First read the original item, repository labels, and likely duplicate issues with the GitHub tools. Pass that evidence here. Returns type, priority, complexity, labels, duplicates, and lane (pipeline, clarify, answer, duplicate). Apply selected labels separately with github__addLabels. A duplicate decision is a suggestion: confirm it before closing anything.",
  execute({ title, body, labels, candidates }, ctx) {
    return triageWorkItem({ body, title }, labels, candidates, {
      signal: ctx.abortSignal,
    });
  },
  inputSchema: z.object({
    body: z.string().min(1).max(40_000),
    candidates: z
      .array(
        z.object({
          number: z.number().int().positive(),
          state: z.string().max(30).optional(),
          title: z.string().max(300),
        })
      )
      .max(15)
      .default([]),
    labels: z
      .array(
        z.object({
          description: z.string().max(200).nullable().optional(),
          name: z.string().min(1).max(50),
        })
      )
      .max(100)
      .default([]),
    title: z.string().min(1).max(500),
  }),
});
