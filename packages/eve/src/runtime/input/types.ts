import { z } from "#compiled/zod/index.js";

import { runtimeToolCallActionRequestSchema } from "#runtime/actions/types.js";

/**
 * One selectable option presented to the user in an input request.
 */
export type InputOption = z.infer<typeof inputOptionSchema>;

/**
 * Zod schema for one input option.
 *
 * Includes descriptions because the `ask_question` tool input embeds this
 * schema and exposes it directly to the model.
 */
export const inputOptionSchema = z
  .object({
    description: z.string().describe("Optional additional context for this option.").optional(),
    id: z.string().describe("Stable identifier for the option."),
    label: z.string().describe("User-facing label for the option."),
    style: z
      .enum(["primary", "danger", "default"])
      .describe("Visual treatment hint for the option.")
      .optional(),
  })
  .strict();

/**
 * Unified input request surfaced to the client when the agent needs
 * user input before continuing.
 *
 * Tool approvals and questions share this shape. Approvals are requests
 * with two options (`"approve"` / `"deny"`) and `display: "confirmation"`.
 */
export type InputRequest = z.infer<typeof inputRequestSchema>;

/**
 * Zod schema for one input request.
 */
export const inputRequestSchema = z
  .object({
    action: runtimeToolCallActionRequestSchema,
    allowFreeform: z
      .boolean()
      .describe(
        "Whether the user may answer with freeform text instead of selecting one of the provided options.",
      )
      .optional(),
    display: z
      .enum(["confirmation", "select", "text"])
      .describe("Rendering hint: the channel uses this to pick a UX treatment.")
      .optional(),
    options: z
      .array(inputOptionSchema)
      .describe("Selectable answer options to present to the user.")
      .optional(),
    prompt: z.string().describe("The prompt to present to the user."),
    requestId: z.string().describe("Stable identifier for this request."),
  })
  .strict();

/**
 * Unified input response submitted by the client for a pending request.
 */
export type InputResponse = z.infer<typeof inputResponseSchema>;

/**
 * Zod schema for one input response.
 */
export const inputResponseSchema = z
  .object({
    optionId: z.string().optional(),
    requestId: z.string(),
    text: z.string().optional(),
  })
  .strict();

/**
 * Returns true when a value matches the input request contract.
 */
export function isInputRequest(value: unknown): value is InputRequest {
  return inputRequestSchema.safeParse(value).success;
}

/**
 * Returns true when a value matches the input response contract.
 */
export function isInputResponse(value: unknown): value is InputResponse {
  return inputResponseSchema.safeParse(value).success;
}
