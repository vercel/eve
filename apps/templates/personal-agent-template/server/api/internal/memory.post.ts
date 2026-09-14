import { z } from "zod";
import { setMemoryForCategory } from "~~/server/utils/memory";
import { requireInternalRequest } from "~~/server/utils/internal-api";
import { memoryCategorySchema } from "~~/server/schemas/memory";

const saveMemoryBodySchema = z.object({
  userId: z.string().trim().min(1),
  category: memoryCategorySchema,
  content: z.string().trim().min(1),
  source: z.enum(["import", "agent", "manual"]).default("agent"),
});

export default defineEventHandler(async (event) => {
  requireInternalRequest(event);

  const body = await readValidatedBody(event, saveMemoryBodySchema.parse);
  const result = await setMemoryForCategory(body.userId, {
    category: body.category,
    content: body.content,
    source: body.source,
  });

  if (!result.saved) {
    return { saved: false, reason: result.reason ?? ("unchanged" as const) };
  }

  return { saved: true, entry: result.entry };
});
