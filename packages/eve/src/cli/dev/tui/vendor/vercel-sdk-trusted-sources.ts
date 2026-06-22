/*
 * Schema slice vendored from @vercel/sdk@1.28.1's Speakeasy-generated
 * updateProject request model (Apache-2.0).
 *
 * The generated objects are passthrough here because this TUI reads, merges,
 * and writes the complete Trusted Sources field. Preserving fields added by a
 * newer API avoids deleting policy that this pinned schema does not know yet.
 */
import { z } from "zod";

const EnvironmentSetSchema = z.union([
  z
    .object({
      slugs: z.array(z.string()),
      preset: z.literal("all-custom").optional(),
    })
    .passthrough(),
  z
    .object({
      slugs: z.array(z.string()).optional(),
      preset: z.literal("all-custom"),
    })
    .passthrough(),
]);

const EnvironmentRuleSchema = z
  .object({
    from: EnvironmentSetSchema,
    to: EnvironmentSetSchema,
  })
  .passthrough();

const ProjectRuleSchema = z
  .object({
    label: z.string().optional(),
    customAllow: z.array(EnvironmentRuleSchema).optional(),
  })
  .passthrough();

const OidcProviderRuleSchema = z
  .object({
    label: z.string().optional(),
    to: EnvironmentSetSchema,
    claims: z.record(z.string(), z.array(z.string())),
  })
  .passthrough();

export const VercelTrustedSourcesSchema = z
  .object({
    projects: z.record(z.string(), ProjectRuleSchema).optional(),
    oidcProviders: z.record(z.string(), z.array(OidcProviderRuleSchema)).optional(),
  })
  .passthrough();

const UpdateTrustedSourcesRequestSchema = z.object({
  trustedSources: VercelTrustedSourcesSchema,
});

export type TrustedSourceEnvironmentSet = z.infer<typeof EnvironmentSetSchema>;
export type TrustedSourceEnvironmentRule = z.infer<typeof EnvironmentRuleSchema>;
export type VercelTrustedSources = z.infer<typeof VercelTrustedSourcesSchema>;

/** Validates the vendored updateProject slice before it crosses the CLI boundary. */
export function serializeTrustedSourcesUpdate(trustedSources: VercelTrustedSources): string {
  return JSON.stringify(UpdateTrustedSourcesRequestSchema.parse({ trustedSources }).trustedSources);
}
