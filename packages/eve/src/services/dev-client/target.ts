/** Server target used by development clients. */
interface DevelopmentTargetBase {
  readonly serverUrl: string;
  /** Local workspace root for app files and the fallback Vercel project link. */
  readonly workspaceRoot: string;
}

/** A development client backed by a local `eve dev` server. */
export interface LocalDevelopmentTarget extends DevelopmentTargetBase {
  readonly kind: "local";
}

/** A development client connected to an existing remote server. */
export interface RemoteDevelopmentTarget extends DevelopmentTargetBase {
  readonly kind: "remote";
}

/** Local or remote server backing a development client. */
export type DevelopmentTarget = LocalDevelopmentTarget | RemoteDevelopmentTarget;
