import { z } from "#compiled/zod/index.js";

import { RegistryPackageComponentSchema } from "./registry-package.js";

const RegistrySetupSchema = z.object({
  package: z.string().min(1),
  bin: z.string().min(1),
  args: z.array(z.string()).default([]),
});

const EveRegistryItemMetadataSchema = z.object({
  meta: z
    .object({
      eve: z
        .object({
          requires: z.string().optional(),
          docs: z.string().min(1).optional(),
          implementation: z.enum(["native", "chat-sdk"]).optional(),
          setup: z
            .union([RegistrySetupSchema, z.array(RegistrySetupSchema).min(1)])
            .transform((setup) => (Array.isArray(setup) ? setup : [setup]))
            .optional(),
          components: z.array(RegistryPackageComponentSchema).min(1).optional(),
        })
        .optional(),
    })
    .optional(),
});

/** Parses eve-owned metadata from a registry item manifest. */
export function eveMetadataFromRegistryItem(item: unknown) {
  return EveRegistryItemMetadataSchema.parse(item).meta?.eve;
}
