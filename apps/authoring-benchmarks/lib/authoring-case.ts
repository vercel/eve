import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";
import type { HarnessAgentSession } from "@ai-sdk/harness/agent";

export interface AuthoringSetupContext {
  readonly sandbox: HarnessV1NetworkSandboxSession;
  readonly workspace: string;
  readonly sourceRoot: string;
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
  readonly toolCalls: ReadonlyArray<{ input: unknown }>;
}

export interface AuthoringInteractionContext {
  readonly session: HarnessAgentSession;
  readonly transcript: ReadonlyArray<AuthoringTranscriptEntry>;
  send(prompt: string): Promise<AuthoringTurn>;
}

export interface AuthoringTranscriptEntry {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface AuthoringCase {
  readonly startingPoint: AuthoringStartingPoint;
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
