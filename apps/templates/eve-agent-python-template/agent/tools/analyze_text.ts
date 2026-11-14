import { defineTool } from "eve/tools";
import { z } from "zod";
import { backendRequest } from "../lib/backend";
import { textAnalysisSchema } from "../lib/python-tools";

export default defineTool({
  description:
    "Analyze a piece of text: character, word, sentence and paragraph counts, reading time, Flesch reading ease, and the most frequent non-stopword words. Runs in Python.",
  inputSchema: z.object({
    text: z.string().min(1).max(100_000).describe("The text to analyze."),
    top_n: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("How many top words to return (default 10)."),
  }),
  outputSchema: textAnalysisSchema,
  label: {
    start: ({ text }) => `Analyzing ${text.length.toLocaleString("en-US")} characters in Python`,
    complete: (_input, output) => `Analyzed ${output.words} words`,
  },
  async execute({ text, top_n }) {
    const analysis = await backendRequest("/tools/analyze-text", { body: { text, top_n } });
    return textAnalysisSchema.parse(analysis);
  },
});
