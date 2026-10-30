import { z } from "#compiled/zod/index.js";

import { interactionRequestSchema } from "#protocol/session-events/families/interaction.js";
import type { Interaction } from "#protocol/session-projection/reader.js";

/** Shared JSON projection for invocation results. Sign-in callbacks stay on the server. */
export const interactionJsonSchema = z.object({
  interactionId: z.string(),
  request: interactionRequestSchema.extend({
    signIn: interactionRequestSchema.shape.signIn.unwrap().omit({ callbackUrl: true }).optional(),
  }),
  call: z.object({ callId: z.string(), name: z.string(), input: z.json().optional() }).optional(),
  status: z.enum(["open", "settled"]),
  outcome: z
    .enum([
      "accepted",
      "declined",
      "invalid",
      "failed",
      "withdrawn",
      "interrupted",
      "abandoned",
      "expired",
    ])
    .optional(),
  reason: z.string().optional(),
  answer: z
    .object({
      interactionId: z.string(),
      optionId: z.string().optional(),
      text: z.string().optional(),
    })
    .optional(),
  turnId: z.string(),
  stepIndex: z.number().int().nonnegative(),
  taskId: z.string().optional(),
});

export function interactionJson(value: Interaction): z.infer<typeof interactionJsonSchema> {
  return interactionJsonSchema.parse(value);
}
