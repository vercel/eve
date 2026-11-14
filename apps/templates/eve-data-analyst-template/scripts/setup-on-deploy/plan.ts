/**
 * Decides what the deploy step should set up, from environment variables alone.
 *
 * @packageDocumentation
 */
import { z } from "zod";

import { derivedLoginProblem, isEnabled } from "#lib/analyst/derived-login";
import { isSafeIdentifier, isSafeSchemaName } from "#lib/analyst/identifiers";
import { resolveSchemaLists } from "#lib/analyst/schemas";

/** Demo data older than this is reloaded on the next deploy, so recent-period questions keep working. */
export const DEMO_DATA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** What the deploy step does. */
export type DeploySetupPlan =
  | { readonly action: "skip"; readonly reason: string }
  | {
      readonly action: "setup";
      readonly baseRole: string;
      /** Schema names left out because they aren't valid, or because a shared schema isn't in `ANALYST_SCHEMAS`. */
      readonly ignoredSchemas: readonly string[];
      readonly ownerUrl: string;
      readonly schemas: readonly string[];
      readonly seedDemoData: boolean;
      readonly sharedSchemas: readonly string[];
      readonly teamRoles: readonly string[];
    };

/* Role names from ANALYST_ROLE_MAP; invalid JSON or names surface later when the agent validates its settings. */
const mappedRoles = (value: string | undefined): string[] => {
  try {
    const parsed = z
      .record(z.string(), z.string())
      .safeParse(JSON.parse(value?.trim() || "{}"));
    return parsed.success
      ? Object.values(parsed.data).filter(isSafeIdentifier)
      : [];
  } catch {
    return [];
  }
};

/**
 * Plans the deploy-time setup.
 *
 * @param env - Build environment variables.
 * @returns `skip` with a reason, or the explored schemas, shared schemas, and roles to set up with the owner connection.
 * @remarks Nothing runs when `ANALYST_DATABASE_URL` is set, because that means the login is managed by hand, or when the login can't be derived from `DATABASE_URL`, such as when it has no password. Never throws, because it runs before the deploy step's error handling, so unsafe names and shared schemas missing from `ANALYST_SCHEMAS` are dropped here, listed in `ignoredSchemas`, and reported in full when the agent validates its settings. Both lists come from `resolveSchemaLists`, as they do for the agent and `db:setup-sql`.
 */
export const planDeploySetup = (env: NodeJS.ProcessEnv): DeploySetupPlan => {
  if (env.ANALYST_DATABASE_URL?.trim()) {
    return {
      action: "skip",
      reason:
        "ANALYST_DATABASE_URL is set, so the read-only login is managed by hand.",
    };
  }
  const ownerUrl = env.DATABASE_URL?.trim();
  if (!ownerUrl) {
    return {
      action: "skip",
      reason:
        "DATABASE_URL isn't set. Add it to the project and redeploy to finish setup.",
    };
  }
  const problem = derivedLoginProblem(ownerUrl);
  if (problem) {
    return { action: "skip", reason: `DATABASE_URL ${problem}` };
  }
  const lists = resolveSchemaLists(env);
  const schemas = lists.schemas.filter(isSafeSchemaName);
  const sharedSchemas = lists.sharedSchemas.filter((schema) =>
    schemas.includes(schema)
  );
  const ignoredSchemas = [
    ...new Set([...lists.schemas, ...lists.sharedSchemas]),
  ].filter(
    (schema) => !(schemas.includes(schema) || sharedSchemas.includes(schema))
  );
  const baseRole = env.ANALYST_DEFAULT_ROLE?.trim() || "analyst_readonly";
  return {
    action: "setup",
    baseRole,
    ignoredSchemas,
    ownerUrl,
    schemas,
    seedDemoData: isEnabled(env.ANALYST_SEED_DEMO_DATA),
    sharedSchemas,
    teamRoles: mappedRoles(env.ANALYST_ROLE_MAP),
  };
};

/**
 * Decides whether demo data needs (re)loading.
 *
 * @param anchorAt - When the existing demo data was generated up to, or null when there is none.
 * @param now - Current time.
 * @returns Whether to load fresh demo data.
 */
export const needsDemoReload = (anchorAt: Date | null, now: Date): boolean =>
  anchorAt === null ||
  now.getTime() - anchorAt.getTime() > DEMO_DATA_MAX_AGE_MS;
