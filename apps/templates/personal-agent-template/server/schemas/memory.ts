import { z } from "zod";
import { MEMORY_CATEGORIES } from "#shared/types/memory";

export const memoryCategorySchema = z.enum(MEMORY_CATEGORIES);

export const importMemoryBodySchema = z.object({
  raw: z.string().trim().min(1),
});

export const patchMemoryBodySchema = z.object({
  content: z.string().trim().min(1).max(10000),
});

export const memoryIdParamsSchema = z.object({
  id: z.string().trim().uuid(),
});

export const internalMemoryQuerySchema = z.object({
  userId: z.string().trim().min(1),
});
