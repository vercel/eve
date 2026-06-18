import { z } from "zod";

const TrustedSourceEnvironmentSetSchema = z
  .object({
    slugs: z.array(z.string()).optional(),
    preset: z.literal("all-custom").optional(),
  })
  .passthrough();

const TrustedSourceEnvironmentRuleSchema = z
  .object({
    from: TrustedSourceEnvironmentSetSchema,
    to: TrustedSourceEnvironmentSetSchema,
  })
  .passthrough();

const TrustedSourceProjectRuleSchema = z
  .object({
    label: z.string().optional(),
    customAllow: z.array(TrustedSourceEnvironmentRuleSchema).optional(),
  })
  .passthrough();

export const VercelTrustedSourcesSchema = z
  .object({
    projects: z.record(z.string(), TrustedSourceProjectRuleSchema).optional(),
    oidcProviders: z.record(z.string(), z.array(z.unknown())).optional(),
  })
  .passthrough();

export type TrustedSourceEnvironmentSet = z.infer<typeof TrustedSourceEnvironmentSetSchema>;
export type TrustedSourceEnvironmentRule = z.infer<typeof TrustedSourceEnvironmentRuleSchema>;
export type TrustedSourceProjectRule = z.infer<typeof TrustedSourceProjectRuleSchema>;
export type VercelTrustedSources = z.infer<typeof VercelTrustedSourcesSchema>;

export interface TrustedSourceEndpoint {
  readonly projectId: string;
  readonly environment: string;
  readonly customEnvironmentSlugs: readonly string[];
}

export type TrustedSourceAccessPlan =
  | { readonly kind: "unchanged" }
  | { readonly kind: "update"; readonly trustedSources: VercelTrustedSources };

const SYSTEM_ENVIRONMENTS = new Set(["development", "preview", "production"]);

function environmentSetIncludes(set: TrustedSourceEnvironmentSet, environment: string): boolean {
  if (set.slugs?.includes(environment) === true) return true;
  return set.preset === "all-custom" && !SYSTEM_ENVIRONMENTS.has(environment);
}

function ruleIncludes(
  rule: TrustedSourceEnvironmentRule,
  sourceEnvironment: string,
  targetEnvironment: string,
): boolean {
  return (
    environmentSetIncludes(rule.from, sourceEnvironment) &&
    environmentSetIncludes(rule.to, targetEnvironment)
  );
}

function environmentRule(from: string, to: string): TrustedSourceEnvironmentRule {
  return { from: { slugs: [from] }, to: { slugs: [to] } };
}

function defaultRules(
  source: TrustedSourceEndpoint,
  target: TrustedSourceEndpoint,
): TrustedSourceEnvironmentRule[] {
  const rules = [
    environmentRule("production", "production"),
    environmentRule("preview", "preview"),
  ];
  const targetCustomEnvironments = new Set(target.customEnvironmentSlugs);
  for (const environment of source.customEnvironmentSlugs) {
    if (targetCustomEnvironments.has(environment)) {
      rules.push(environmentRule(environment, environment));
    }
  }
  if (source.projectId === target.projectId) {
    rules.push(environmentRule("development", "preview"));
  }
  return rules;
}

function defaultAccessIncludes(input: {
  readonly source: TrustedSourceEndpoint;
  readonly target: TrustedSourceEndpoint;
  readonly projectRule: TrustedSourceProjectRule | undefined;
}): boolean {
  const projectIsTrusted =
    input.source.projectId === input.target.projectId || input.projectRule !== undefined;
  return (
    projectIsTrusted &&
    defaultRules(input.source, input.target).some((rule) =>
      ruleIncludes(rule, input.source.environment, input.target.environment),
    )
  );
}

/**
 * Plans the smallest Trusted Sources update that permits one source/target
 * environment pair while preserving the target project's existing policy.
 */
export function planTrustedSourceAccess(input: {
  readonly source: TrustedSourceEndpoint;
  readonly target: TrustedSourceEndpoint;
  readonly trustedSources?: VercelTrustedSources;
}): TrustedSourceAccessPlan {
  const projectRule = input.trustedSources?.projects?.[input.source.projectId];
  const explicitRules = projectRule?.customAllow;
  const alreadyAuthorized =
    explicitRules === undefined
      ? defaultAccessIncludes({ ...input, projectRule })
      : explicitRules.some((rule) =>
          ruleIncludes(rule, input.source.environment, input.target.environment),
        );
  if (alreadyAuthorized) return { kind: "unchanged" };

  const customAllow = [
    ...(explicitRules ?? defaultRules(input.source, input.target)),
    environmentRule(input.source.environment, input.target.environment),
  ];
  return {
    kind: "update",
    trustedSources: {
      ...input.trustedSources,
      projects: {
        ...input.trustedSources?.projects,
        [input.source.projectId]: {
          ...projectRule,
          customAllow,
        },
      },
    },
  };
}
