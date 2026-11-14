import { z } from "zod";
import { browserImageArtifactReferenceSchema } from "@shared/browser/artifact";

export const maximumWorkerCompletionImages = 4;

export const taskCompletionSchema = z.object({
  images: z
    .array(browserImageArtifactReferenceSchema)
    .max(maximumWorkerCompletionImages),
  status: z.enum(["success", "failure"]),
  message: z.string().trim().min(1),
});

const historicalTaskCompletionSchema = taskCompletionSchema.omit({
  images: true,
});

export const taskCompletionOutputSchema = z.preprocess(
  (input) => {
    const text = z.string().safeParse(input);
    if (!text.success) return input;
    try {
      const parsed = z.json().safeParse(JSON.parse(text.data));
      return parsed.success ? parsed.data : input;
    } catch {
      return input;
    }
  },
  z.union([
    taskCompletionSchema,
    historicalTaskCompletionSchema.transform((value) => ({
      ...value,
      images: [],
    })),
  ])
);
