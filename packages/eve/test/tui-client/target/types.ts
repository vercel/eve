import type { AgentServerHandle, AgentServerMode } from "../lib/server.ts";

export type StartTestAgentServer = (input: {
  readonly appName: string;
  readonly mode?: AgentServerMode;
  readonly port?: number;
  readonly signal?: AbortSignal;
  readonly startEnv?: NodeJS.ProcessEnv;
}) => Promise<AgentServerHandle>;

export type TestTargetKind = "local-build" | "local-dev";

export type TestEnvironmentKind = "local";

export interface TestTargetCapabilities {
  readonly devRoutes: boolean;

  readonly ownedProcess: boolean;

  readonly localBuildOutput: boolean;

  readonly mutableStartupEnv: boolean;
}

export type TestTargetCapability = keyof TestTargetCapabilities;

export interface TestTarget {
  readonly app: string;
  readonly kind: TestTargetKind;
  readonly baseUrl: string;
  readonly capabilities: TestTargetCapabilities;

  stop(): Promise<void>;
}

export interface LocalBuildTestTargetRequest {
  readonly kind: "local-build";
  readonly app: string;
  readonly port?: number;
  readonly startEnv?: NodeJS.ProcessEnv;
}

export interface LocalDevTestTargetRequest {
  readonly kind: "local-dev";
  readonly app: string;
  readonly port?: number;
  readonly startEnv?: NodeJS.ProcessEnv;
}

export type LocalTestTargetRequest = LocalBuildTestTargetRequest | LocalDevTestTargetRequest;

export interface LocalTestEnvironment {
  readonly kind: "local";
  target(input: LocalTestTargetRequest): Promise<TestTarget>;
  stop(): Promise<void>;
}

export type TestEnvironment = LocalTestEnvironment;

export interface CreateLocalTestEnvironmentOptions {
  readonly firstPort?: number;

  readonly startServer?: StartTestAgentServer;
}
