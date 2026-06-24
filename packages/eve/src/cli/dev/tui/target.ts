import { basename } from "node:path";

interface DevelopmentTargetBase {
  readonly serverUrl: string;
  /** Local workspace root for app files and the fallback Vercel project link. */
  readonly workspaceRoot: string;
}

/** A development TUI session backed by the local `eve dev` server. */
export interface LocalDevelopmentTarget extends DevelopmentTargetBase {
  readonly kind: "local";
}

/** A development TUI session connected to an existing remote server. */
export interface RemoteDevelopmentTarget extends DevelopmentTargetBase {
  readonly kind: "remote";
}

/** Local or remote server backing one development TUI session. */
export type DevelopmentTuiTarget = LocalDevelopmentTarget | RemoteDevelopmentTarget;

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
