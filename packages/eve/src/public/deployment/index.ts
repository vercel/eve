import { readBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";

/** Git source identity captured while a production deployment is built. */
export interface DeploymentSource {
  /** Canonical `github.com/owner/repository` identity. */
  readonly repository: string;
  readonly revision: string;
  /** Repository-relative application root, or `.` when the app is at repository root. */
  readonly rootDirectory: string;
}

/** Returns the production build's source identity when one was captured. */
export function getDeploymentSource(): DeploymentSource | null {
  return readBundledCompiledArtifacts()?.deploymentSource ?? null;
}
