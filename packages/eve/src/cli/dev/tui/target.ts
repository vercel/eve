import { basename } from "node:path";

import type {
  DevelopmentTarget,
  LocalDevelopmentTarget,
  RemoteDevelopmentTarget,
} from "#services/dev-client/target.js";

export type { LocalDevelopmentTarget, RemoteDevelopmentTarget };

/** Local or remote server backing one development TUI session. */
export type DevelopmentTuiTarget = DevelopmentTarget;

/** Resolves the explicit name, remote host, or humanized local folder shown by the TUI. */
export function resolveTuiTitle(input: {
  readonly name: string | undefined;
  readonly target: DevelopmentTuiTarget;
}): string | undefined {
  if (input.name !== undefined && input.name.length > 0) return input.name;

  if (input.target.kind === "remote") {
    try {
      return new URL(input.target.serverUrl).host;
    } catch {
      return undefined;
    }
  }

  const humanized = basename(input.target.workspaceRoot)
    .replace(/[-_.]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
  return humanized.length > 0 ? humanized : undefined;
}

/** Returns the URL host shown in remote status and authentication messages. */
export function remoteHost(target: RemoteDevelopmentTarget): string {
  return new URL(target.serverUrl).host;
}
