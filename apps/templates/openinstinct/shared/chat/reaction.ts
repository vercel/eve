import { z } from "zod";

const reactionTypeSchema = z.enum([
  "thumbs_up",
  "thumbs_down",
  "heart",
  "laugh",
  "exclamation",
  "question",
]);

export const reactToMessageOutputSchema = z.object({
  operation: z.enum(["add", "remove"]).default("add"),
  type: reactionTypeSchema,
});

export const addReactionToMessageOutputSchema =
  reactToMessageOutputSchema.extend({
    operation: z.literal("add").default("add"),
  });

const reactionText = {
  exclamation: "‼️",
  heart: "❤️",
  laugh: "😂",
  question: "❓",
  thumbs_down: "👎",
  thumbs_up: "👍",
} as const satisfies Record<z.infer<typeof reactionTypeSchema>, string>;

export function reactionTextFor(type: z.infer<typeof reactionTypeSchema>) {
  return reactionText[type];
}

export const reactToMessageToolResultSchema = z.object({
  kind: z.literal("tool-result"),
  output: reactToMessageOutputSchema,
  toolName: z.literal("react_to_message"),
});
