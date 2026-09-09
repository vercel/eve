/** Server target used by development clients. */
interface DevelopmentTargetBase {
  readonly serverUrl: string;
  /** Project root for shared dependencies, Vercel links, and environment files. */
  readonly workspaceRoot: string;
  /** The selected agent's root when it is a member of a multi-agent project. */
  readonly agentRoot?: string;
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
