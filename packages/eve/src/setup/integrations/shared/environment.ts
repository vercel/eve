import type { ProjectResolution } from "../../project-resolution.js";
import type { VercelAuthStatus } from "../../vercel-project.js";

/** Read-only hosting facts available to channel-owned setup hooks. */
export interface IntegrationSetupEnvironment {
  vercel:
    | { kind: "available"; project: ProjectResolution }
    | { kind: "unavailable"; reason: Exclude<VercelAuthStatus, "authenticated"> };
}

/** Describes the result of the read-only Vercel capability probe. */
export function describeIntegrationSetupEnvironment(
  environment: IntegrationSetupEnvironment,
): string {
  if (environment.vercel.kind === "available") {
    switch (environment.vercel.project.kind) {
      case "deployed":
        return `Found an authenticated Vercel account and deployed project (${environment.vercel.project.productionUrl}).`;
      case "linked":
        return "Found an authenticated Vercel account and linked project.";
      case "unresolved":
        return "Found an authenticated Vercel account; this directory is not linked to a project.";
    }
  }
  switch (environment.vercel.reason) {
    case "logged-out":
      return "No authenticated Vercel account found; choose Vercel Connect or portable credentials.";
    case "cli-missing":
      return "Vercel CLI not found; choose Vercel Connect or portable credentials.";
    case "unavailable":
      return "Could not verify the Vercel account; choose Vercel Connect or portable credentials.";
  }
}

/** Builds channel setup facts from the independent Vercel probes. */
export function integrationSetupEnvironment(
  authStatus: VercelAuthStatus,
  project: ProjectResolution,
): IntegrationSetupEnvironment {
  return authStatus === "authenticated"
    ? { vercel: { kind: "available", project } }
    : { vercel: { kind: "unavailable", reason: authStatus } };
}
