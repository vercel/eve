import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";

/** One external interaction observed by a benchmark world. */
export interface WorldEvent {
  readonly at: string;
  readonly type: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Stateful external systems presented to the subject inside its sandbox. */
export interface BenchmarkWorld {
  readonly id: string;
  /** Sandbox environment inherited by every subject command. */
  readonly env: Readonly<Record<string, string>>;
  /** Hosts the world expects the sandbox to contact directly. */
  readonly allowedHosts: readonly string[];
  /** Installs immutable world support into a reusable sandbox template. */
  bootstrap(input: {
    readonly sandbox: import("@ai-sdk/provider-utils").Experimental_SandboxSession;
  }): Promise<void>;
  /** Starts fresh, run-scoped world state in one sandbox fork. */
  install(input: {
    readonly sandbox: HarnessV1NetworkSandboxSession;
    readonly workspace: string;
  }): Promise<void>;
  events(): Promise<readonly WorldEvent[]>;
  dispose(): Promise<void>;
}

/** A deliberately narrow user who answers only facts owned by the user. */
export interface UserSimulator {
  respond(
    message: string,
  ): Promise<{ kind: "answer"; text: string } | { kind: "fail"; reason: string }>;
}

/** Input shared by authoring benchmark cases. */
export interface AuthoringCase {
  readonly id: string;
  readonly prompt: string;
  readonly instructions: string;
  readonly maximumUserTurns: number;
  createUser(): UserSimulator;
  createWorld(): BenchmarkWorld;
  grade(input: GradeInput): Promise<BenchmarkGrade>;
}

export interface SubjectTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface SubjectToolCall {
  readonly name: string;
  readonly input: unknown;
}

export interface SubjectToolResult {
  readonly name: string;
  readonly output: unknown;
}

export interface GradeInput {
  readonly sandbox: HarnessV1NetworkSandboxSession;
  readonly workspace: string;
  readonly transcript: readonly SubjectTurn[];
  readonly toolCalls: readonly SubjectToolCall[];
  readonly toolResults: readonly SubjectToolResult[];
  readonly worldEvents: readonly WorldEvent[];
  readonly usage: Readonly<Record<string, unknown>>;
}

export interface GradeCheck {
  readonly id: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface BenchmarkGrade {
  readonly passed: boolean;
  readonly checks: readonly GradeCheck[];
}

export interface BenchmarkRunArtifact {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly harness: string;
  readonly model?: string;
  readonly subjectRevision: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly artifactPath: string;
  readonly transcript: readonly SubjectTurn[];
  readonly toolCalls: readonly SubjectToolCall[];
  readonly toolResults: readonly SubjectToolResult[];
  readonly diagnostics: readonly unknown[];
  readonly worldEvents: readonly WorldEvent[];
  readonly usage: Readonly<Record<string, unknown>>;
  readonly grade: BenchmarkGrade;
  readonly summary?: { readonly model: string; readonly text: string };
  readonly error?: string;
}
