import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

/** Keeps framework runtime imports outside the third-party package plan. */
export function externalDependencyPlanPackageNames(dependencies: readonly string[]): string[] {
  return [...new Set(dependencies)]
    .filter((packageName) => packageName !== EVE_PACKAGE_NAME)
    .sort();
}
