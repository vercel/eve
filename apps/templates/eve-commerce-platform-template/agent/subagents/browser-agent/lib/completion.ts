import { z } from "zod";
import {
  browserImageArtifactReferenceSchema,
  maximumBrowserResultImages,
} from "@/lib/browser/artifact";

export const taskCompletionSchema = z.object({
  images: z.array(browserImageArtifactReferenceSchema).max(maximumBrowserResultImages),
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
  ]),
);
