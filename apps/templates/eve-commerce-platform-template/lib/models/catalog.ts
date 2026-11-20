import { z } from "zod";

export const modelCatalogSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    ownedBy: z.string(),
    pricing: z
      .object({
        input: z.number().nonnegative().optional(),
        output: z.number().nonnegative().optional(),
      })
      .optional(),
  }),
);

export type ModelCatalogItem = z.infer<typeof modelCatalogSchema>[number];
