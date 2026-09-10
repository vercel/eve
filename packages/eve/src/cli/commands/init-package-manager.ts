import type { PackageManagerKind } from "#setup/package-manager.js";
import { resultSucceeded, type PackageManagerProcessResult } from "#setup/primitives/index.js";

export async function resolveScaffoldPackageManager(input: {
  detectInvokingPackageManager(): PackageManagerKind | undefined;
  detectPackageManager(projectPath: string): Promise<{ kind: PackageManagerKind; source: string }>;
  projectPath: string;
}): Promise<PackageManagerKind> {
  const detected = await input.detectPackageManager(input.projectPath);
  return detected.source === "default"
    ? (input.detectInvokingPackageManager() ?? "pnpm")
    : detected.kind;
}

export function packageManagerPreflightFailureMessage(result: PackageManagerProcessResult): string {
  if (result.termination.kind === "spawn-error") {
    return result.termination.code === "ENOENT"
      ? `${result.command.executable} was not found. Install it before running eve init.`
      : `Could not start ${result.command.executable}: ${result.termination.message}`;
  }
  return `Could not verify ${result.command.executable}. Run ${result.command.executable} --version, then retry eve init.`;
}

export async function assertPackageManagerAvailable(
  checkPackageManagerAvailability: (
    kind: PackageManagerKind,
    cwd: string,
  ) => Promise<PackageManagerProcessResult>,
  kind: PackageManagerKind,
  cwd: string,
): Promise<void> {
  const result = await checkPackageManagerAvailability(kind, cwd);
  if (!resultSucceeded(result)) throw new Error(packageManagerPreflightFailureMessage(result));
}
