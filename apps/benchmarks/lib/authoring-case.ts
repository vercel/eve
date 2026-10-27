export interface AuthoringSetupContext {
  readonly workspace: string;
  readonly artifactsRoot: string;
  /** The eve package under test, as an npm install specifier. */
  readonly packageSpec: string;
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
  /** Agent time limit for large cases. A run uses the longest limit among its selected cases. */
  readonly timeoutSeconds?: number;
  /**
   * Validate the result with `eve build --skip-sandbox-prewarm`, for an empty-workspace case
   * whose sandbox needs Vercel credentials the eval sandbox doesn't have.
   */
  readonly skipSandboxPrewarm?: boolean;
  readonly setup?: AuthoringSetup;
  readonly interact: (context: AuthoringInteractionContext) => Promise<void>;
}

export const emptyProject: AuthoringStartingPoint = {
  id: "empty-v3",
  workspace: "empty",
};

export const simpleProject: AuthoringStartingPoint = {
  id: "simple-v3",
  workspace: "scaffolded",
};

export function defineAuthoringCase(authoringCase: AuthoringCase): AuthoringCase {
  return authoringCase;
}
