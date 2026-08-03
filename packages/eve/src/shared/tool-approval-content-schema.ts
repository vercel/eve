import { z } from "#compiled/zod/index.js";

const safeString = z.string().refine((value) => !hasUnsafeControl(value), {
  message: "Tool approval content must not contain terminal control characters.",
});

function hasUnsafeControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0)!;
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127 || code === 155;
  });
}

/** Runtime schema for review content shown before a tool approval prompt. */
export const toolApprovalContentSchema = z
  .object({
    text: safeString,
    type: z.literal("text"),
  })
  .strict();
