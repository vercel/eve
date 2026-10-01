import { readDevelopmentEnvironmentHostValues } from "#cli/dev/environment.js";
import { captureVercel, type VercelCaptureResult } from "#setup/primitives/run-vercel.js";
import { isObject } from "#shared/guards.js";

const LOCALLY_MANAGED_ENVIRONMENT_KEYS = new Set(["NODE_ENV"]);

export interface DeployEnvironmentCheckDeps {
  captureVercel: typeof captureVercel;
  readLocalEnvironment: typeof readDevelopmentEnvironmentHostValues;
}

export interface DeployEnvironmentCheckResult {
  missing: readonly string[];
  checked: boolean;
}

function isLocallyManagedEnvironmentKey(key: string): boolean {
  return LOCALLY_MANAGED_ENVIRONMENT_KEYS.has(key) || key.startsWith("VERCEL_");
}

function productionEnvironmentKeys(result: VercelCaptureResult): Set<string> | undefined {
  if (!result.ok) return undefined;

  try {
    const value: unknown = JSON.parse(result.stdout);
    if (!isObject(value) || !Array.isArray(value.envs)) return undefined;

    return new Set(
      value.envs.flatMap((environment): string[] =>
        isObject(environment) &&
        typeof environment.key === "string" &&
        environment.gitBranch === undefined
          ? [environment.key]
          : [],
      ),
    );
  } catch {
    return undefined;
  }
}

/** Compares local development env-file keys with the linked project's Production environment. */
export async function checkDeployEnvironment(
  projectPath: string,
  options: { signal?: AbortSignal; deps?: Partial<DeployEnvironmentCheckDeps> } = {},
): Promise<DeployEnvironmentCheckResult> {
  const deps: DeployEnvironmentCheckDeps = {
    captureVercel,
    readLocalEnvironment: readDevelopmentEnvironmentHostValues,
    ...options.deps,
  };
  const localKeys = Object.keys(deps.readLocalEnvironment(projectPath)).filter(
    (key) => !isLocallyManagedEnvironmentKey(key),
  );
  if (localKeys.length === 0) return { checked: true, missing: [] };

  const result = await deps.captureVercel(["env", "list", "production", "--json"], {
    cwd: projectPath,
    nonInteractive: true,
    signal: options.signal,
  });
  const productionKeys = productionEnvironmentKeys(result);
  if (productionKeys === undefined) return { checked: false, missing: [] };

  return {
    checked: true,
    missing: localKeys.filter((key) => !productionKeys.has(key)).sort(),
  };
}
