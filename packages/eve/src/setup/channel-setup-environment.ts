import type { ProjectResolution } from "./project-resolution.js";
import type { VercelAuthStatus } from "./vercel-project.js";

/** Read-only hosting facts available to channel-owned setup hooks. */
export interface ChannelSetupEnvironment {
  vercel:
    | { kind: "available"; project: ProjectResolution }
    | { kind: "unavailable"; reason: Exclude<VercelAuthStatus, "authenticated"> };
}

/** Describes the result of the read-only Vercel capability probe. */
export function describeChannelSetupEnvironment(environment: ChannelSetupEnvironment): string {
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
      return "No authenticated Vercel account found; using portable channel setup.";
    case "cli-missing":
      return "Vercel CLI not found; using portable channel setup.";
    case "unavailable":
      return "Could not verify the Vercel account; using portable channel setup.";
  }
}

/** Builds channel setup facts from the independent Vercel probes. */
export function channelSetupEnvironment(
  authStatus: VercelAuthStatus,
  project: ProjectResolution,
): ChannelSetupEnvironment {
  return authStatus === "authenticated"
    ? { vercel: { kind: "available", project } }
    : { vercel: { kind: "unavailable", reason: authStatus } };
}
