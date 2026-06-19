interface DevelopmentTargetBase {
  readonly serverUrl: string;
  /** Local workspace root; locates `.vercel/project.json` and app files. */
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
