interface DevelopmentTargetBase {
  readonly serverUrl: string;
  readonly workspaceRoot: string;
  readonly agentRoot?: string;
}

export interface LocalDevelopmentTarget extends DevelopmentTargetBase {
  readonly kind: "local";
}

export interface RemoteDevelopmentTarget extends DevelopmentTargetBase {
  readonly kind: "remote";
}

export type DevelopmentTarget = LocalDevelopmentTarget | RemoteDevelopmentTarget;
