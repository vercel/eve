/** Local or remote server backing one development TUI session. */
export type DevelopmentTuiTarget = LocalDevelopmentTarget | RemoteDevelopmentTarget;

/** A development TUI session backed by the local `eve dev` server. */
export interface LocalDevelopmentTarget {
  readonly kind: "local";
  readonly serverUrl: string;
  readonly appRoot: string;
}

/** A development TUI session connected to an existing remote server. */
export interface RemoteDevelopmentTarget {
  readonly kind: "remote";
  readonly serverUrl: string;
  readonly workspaceRoot: string;
}
