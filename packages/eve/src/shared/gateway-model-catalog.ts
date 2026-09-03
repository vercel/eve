import { z } from "#compiled/zod/index.js";

const gatewayCatalogModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  owned_by: z.string(),
  released: z.number().finite().optional().catch(undefined),
  tags: z.array(z.string()).optional().catch(undefined),
  pricing: z
    .object({ service_tiers: z.record(z.string(), z.unknown()).optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

const gatewayCatalogSchema = z.object({ data: z.array(z.unknown()) }).transform(({ data }) =>
  data.flatMap((entry) => {
    const result = gatewayCatalogModelSchema.safeParse(entry);
    return result.success ? [result.data] : [];
  }),
);

/** One model entry from the AI Gateway catalog response. */
export type GatewayCatalogModel = z.infer<typeof gatewayCatalogModelSchema>;

/**
 * Validates a Gateway catalog response. A malformed payload throws, but a
 * malformed entry is skipped so one experimental entry shape cannot discard
 * the rest of the catalog.
 */
export function parseGatewayModelCatalog(input: unknown): GatewayCatalogModel[] {
  const result = gatewayCatalogSchema.safeParse(input);
  if (!result.success) {
    throw new Error("AI Gateway returned an invalid model catalog.");
  }
  return result.data;
}
