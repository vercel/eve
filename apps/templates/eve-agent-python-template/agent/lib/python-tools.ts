import { z } from "zod";

// Imported by apps/web client code (chat tool cards): keep this module free of
// eve runtime, backend, and Node-only imports.

// Mirrors StatsResponse in apps/api/routers/tools.py.
export const statsSchema = z.object({
  count: z.number(),
  sum: z.number(),
  mean: z.number(),
  median: z.number(),
  modes: z.array(z.number()),
  min: z.number(),
  max: z.number(),
  range: z.number(),
  stdev: z.number().nullable(),
  variance: z.number().nullable(),
  quartiles: z.array(z.number()).nullable(),
});

export type Stats = z.infer<typeof statsSchema>;

// Mirrors AnalyzeTextResponse in apps/api/routers/tools.py.
export const textAnalysisSchema = z.object({
  characters: z.number(),
  characters_no_spaces: z.number(),
  words: z.number(),
  unique_words: z.number(),
  sentences: z.number(),
  paragraphs: z.number(),
  average_word_length: z.number(),
  reading_time_minutes: z.number(),
  flesch_reading_ease: z.number(),
  top_words: z.array(z.object({ word: z.string(), count: z.number() })),
});

export type TextAnalysis = z.infer<typeof textAnalysisSchema>;
