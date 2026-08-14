import {
  collectDependencyFacts,
  collectDiscoveryFacts,
  collectGitFacts,
  collectNodeFacts,
  collectPackageManagerFacts,
} from "./collectors.js";
import {
  dependencyDiagnostic,
  discoveryDiagnostic,
  gitDiagnostics,
  nodeDiagnostic,
  packageManagerDiagnostic,
} from "./policies.js";
import type { Diagnostic, DiagnosticStatus } from "./types.js";

export interface DoctorResult {
  summary: Record<DiagnosticStatus, number>;
  diagnostics: readonly Diagnostic[];
}

export async function runLocalDoctor(path: string): Promise<DoctorResult> {
  const discovery = await collectDiscoveryFacts(path);
  const diagnostics: Diagnostic[] = [
    nodeDiagnostic(collectNodeFacts()),
    discoveryDiagnostic(discovery),
  ];
  if (discovery.kind === "resolved") {
    const [packageManager, dependencies, git] = await Promise.all([
      collectPackageManagerFacts(discovery.project.appRoot),
      collectDependencyFacts(discovery.project.appRoot),
      collectGitFacts(discovery.project.appRoot),
    ]);
    diagnostics.push(packageManagerDiagnostic(packageManager));
    diagnostics.push(
      dependencyDiagnostic(
        dependencies,
        packageManager.kind === "observed" ? packageManager.manager : "pnpm",
      ),
    );
    diagnostics.push(...gitDiagnostics(git));
  }
  return {
    diagnostics,
    summary: diagnostics.reduce<Record<DiagnosticStatus, number>>(
      (summary, diagnostic) => {
        summary[diagnostic.status] += 1;
        return summary;
      },
      { pass: 0, warn: 0, fail: 0, unknown: 0 },
    ),
  };
}
