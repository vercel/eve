import type {
  UpdateProjectCustomAllow,
  UpdateProjectTrustedSources,
} from "@vercel/sdk/models/updateprojectprojectsaction.js";

export type TrustedSourceEnvironmentRule = UpdateProjectCustomAllow;

export interface TrustedSourceProject {
  readonly projectId: string;
  readonly customEnvironmentSlugs: readonly string[];
}

type TrustedSourceAccessPlan =
  | { readonly kind: "unchanged" }
  | { readonly kind: "update"; readonly trustedSources: UpdateProjectTrustedSources };

const SYSTEM_ENVIRONMENTS = new Set(["development", "preview", "production"]);

function environmentSetIncludes(
  set: UpdateProjectCustomAllow["from"] | UpdateProjectCustomAllow["to"],
  environment: string,
): boolean {
  if (set.slugs?.includes(environment) === true) return true;
  return set.preset === "all-custom" && !SYSTEM_ENVIRONMENTS.has(environment);
}

function ruleIncludes(
  rule: UpdateProjectCustomAllow,
  sourceEnvironment: string,
  targetEnvironment: string,
): boolean {
  return (
    environmentSetIncludes(rule.from, sourceEnvironment) &&
    environmentSetIncludes(rule.to, targetEnvironment)
  );
}

function environmentRule(from: string, to: string): UpdateProjectCustomAllow {
  return { from: { slugs: [from] }, to: { slugs: [to] } };
}

function defaultRules(project: TrustedSourceProject): UpdateProjectCustomAllow[] {
  const rules = [
    environmentRule("production", "production"),
    environmentRule("preview", "preview"),
    environmentRule("development", "preview"),
  ];
  for (const environment of project.customEnvironmentSlugs) {
    rules.push(environmentRule(environment, environment));
  }
  return rules;
}

/**
 * Plans the smallest policy update that lets a project's Development token
 * reach one of that same project's deployment environments.
 */
export function planTrustedSourceAccess(input: {
  readonly project: TrustedSourceProject;
  readonly targetEnvironment: string;
  readonly trustedSources?: UpdateProjectTrustedSources;
}): TrustedSourceAccessPlan {
  const projectRule = input.trustedSources?.projects?.[input.project.projectId];
  const explicitRules = projectRule?.customAllow;
  const existingRules = explicitRules ?? defaultRules(input.project);
  if (existingRules.some((rule) => ruleIncludes(rule, "development", input.targetEnvironment))) {
    return { kind: "unchanged" };
  }

  const customAllow = [...existingRules, environmentRule("development", input.targetEnvironment)];
  return {
    kind: "update",
    trustedSources: {
      ...input.trustedSources,
      projects: {
        ...input.trustedSources?.projects,
        [input.project.projectId]: {
          ...projectRule,
          customAllow,
        },
      },
    },
  };
}
