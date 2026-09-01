export interface AuthoringSetupContext {
  readonly workspace: string;
  readonly artifactsRoot: string;
  run(command: string, workingDirectory?: string): Promise<void>;
  write(path: string, content: string): Promise<void>;
}

export interface AuthoringStartingPoint {
  /** Change this when the reusable project bootstrap changes. */
  readonly id: string;
  readonly workspace: "scaffolded" | "empty";
  readonly setup?: AuthoringSetup;
}

export interface AuthoringSetup {
  /** Change this when setup behavior or fixture dependencies change. */
  readonly id: string;
  readonly ports?: ReadonlyArray<number>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly onBootstrap?: (context: AuthoringSetupContext) => Promise<void>;
  readonly onSession?: (context: AuthoringSetupContext) => Promise<void>;
}

export interface AuthoringTurn {
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
}

export interface AuthoringInteractionContext {
  send(prompt: string): Promise<AuthoringTurn>;
}

export interface AuthoringCase {
  readonly startingPoint: AuthoringStartingPoint;
  /** Directory created by the agent, relative to the starting workspace. */
  readonly projectDirectory?: string;
  readonly setup?: AuthoringSetup;
  readonly interact: (context: AuthoringInteractionContext) => Promise<void>;
}

export const emptyProject: AuthoringStartingPoint = {
  id: "empty-v2",
  workspace: "empty",
};

export const simpleProject: AuthoringStartingPoint = {
  id: "simple-v2",
  workspace: "scaffolded",
};

export function defineAuthoringCase(authoringCase: AuthoringCase): AuthoringCase {
  return authoringCase;
}
