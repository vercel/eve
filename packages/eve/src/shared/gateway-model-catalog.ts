import { z } from "#compiled/zod/index.js";

const gatewayReasoningEffortSchema = z.object({
  type: z.literal("effort"),
  values: z.array(z.string()).catch([]),
});

const gatewayCatalogModelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    owned_by: z.string(),
    released: z.number().finite().optional().catch(undefined),
    tags: z.array(z.string()).optional().catch(undefined),
    reasoning_options: z.array(z.unknown()).optional().catch(undefined),
    pricing: z
      .object({ service_tiers: z.record(z.string(), z.unknown()).optional().catch(undefined) })
      .optional()
      .catch(undefined),
  })
  .transform(({ reasoning_options, ...model }) => ({
    ...model,
    reasoningEfforts:
      reasoning_options?.flatMap((option) => {
        const result = gatewayReasoningEffortSchema.safeParse(option);
        return result.success ? result.data.values : [];
      }) ?? [],
  }));

const gatewayCatalogSchema = z.object({ data: z.array(z.unknown()) }).transform(({ data }) =>
  data.flatMap((entry) => {
    const result = gatewayCatalogModelSchema.safeParse(entry);
    return result.success ? [result.data] : [];
  }),
);

export type GatewayCatalogModel = z.infer<typeof gatewayCatalogModelSchema>;

export function parseGatewayModelCatalog(input: unknown): GatewayCatalogModel[] {
  const result = gatewayCatalogSchema.safeParse(input);
  if (!result.success) {
    throw new Error("AI Gateway returned an invalid model catalog.");
  }
  return result.data;
}
