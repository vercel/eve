import { z } from "#compiled/zod/index.js";

import { RegistryPackageComponentSchema } from "./registry-package.js";

const RegistrySetupSchema = z.object({
  package: z.string().min(1),
  bin: z.string().min(1),
  args: z.array(z.string()).default([]),
});

const EveRegistryMetadataSchema = z.object({
  requires: z.string().optional(),
  docs: z.string().min(1).optional(),
  implementation: z.enum(["native", "chat-sdk"]).optional(),
  setup: z
    .union([RegistrySetupSchema, z.array(RegistrySetupSchema).min(1)])
    .transform((setup) => (Array.isArray(setup) ? setup : [setup]))
    .optional(),
  components: z.array(RegistryPackageComponentSchema).min(1).optional(),
});

const EveRegistryItemMetadataSchema = z.object({
  meta: z.object({ eve: EveRegistryMetadataSchema.optional() }).optional(),
});

const OfficialRegistryCatalogSchema = z.object({
  items: z.array(
    z.object({
      name: z.string().min(1),
      meta: z.object({ eve: EveRegistryMetadataSchema.optional() }).optional(),
    }),
  ),
});

const RegistryPresentationManifestSchema = EveRegistryItemMetadataSchema.extend({
  title: z.string().optional(),
  description: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  files: z.array(z.object({ target: z.string() })).optional(),
});

export type RegistrySearchMetadata = Pick<
  z.infer<typeof EveRegistryMetadataSchema>,
  "docs" | "implementation"
>;

/** Parses eve-owned metadata from a registry item manifest. */
export function eveMetadataFromRegistryItem(item: unknown) {
  return EveRegistryItemMetadataSchema.parse(item).meta?.eve;
}

/** Extracts search metadata from the eve-owned official registry catalog. */
export function parseOfficialRegistrySearchMetadata(
  input: unknown,
): ReadonlyMap<string, RegistrySearchMetadata> {
  const { items } = OfficialRegistryCatalogSchema.parse(input);
  const metadata = new Map<string, RegistrySearchMetadata>();
  for (const item of items) {
    const { docs, implementation } = item.meta?.eve ?? {};
    if (docs !== undefined || implementation !== undefined) {
      metadata.set(item.name, { docs, implementation });
    }
  }
  return metadata;
}

/** Parses the fields used by the human-readable registry item view. */
export function parseRegistryPresentationManifest(input: unknown) {
  return RegistryPresentationManifestSchema.safeParse(input).data;
}
