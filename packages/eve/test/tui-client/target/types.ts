import type { AgentServerHandle, AgentServerMode } from "../lib/server.ts";

/** Starts one local eve app server for a smoke-test target. */
export type StartTestAgentServer = (input: {
  readonly appName: string;
  readonly mode?: AgentServerMode;
  readonly port?: number;
  readonly signal?: AbortSignal;
  readonly startEnv?: NodeJS.ProcessEnv;
}) => Promise<AgentServerHandle>;

/**
 * Runtime shape a smoke test runs against.
 *
 * The family taxonomy answers "what behavior is this smoke protecting?";
 * the target kind answers "where is that behavior being exercised?".
 */
export type TestTargetKind = "local-build" | "local-dev";

/** Classifies the resolver that owns target lookup for one smoke run. */
export type TestEnvironmentKind = "local";

/**
 * Capabilities that affect whether a smoke can run against a target.
 *
 * These are about the test harness boundary, not app behavior: a target may be
 * fully functional while still lacking mutable startup env.
 */
export interface TestTargetCapabilities {
  /** `POST /eve/v1/dev/*` routes are mounted. */
  readonly devRoutes: boolean;

  /** The smoke harness owns the server process and can stop it. */
  readonly ownedProcess: boolean;

  /** The target serves locally built output instead of a dev server or deployment. */
  readonly localBuildOutput: boolean;

  /** The smoke can choose environment variables before the app boots. */
  readonly mutableStartupEnv: boolean;
}

/** Name of one target capability that smoke tests can require or inspect. */
export type TestTargetCapability = keyof TestTargetCapabilities;

/**
 * One resolved app endpoint.
 *
 * A target is intentionally smaller than an environment: it knows how to call
 * one app and clean up only resources it owns.
 */
export interface TestTarget {
  readonly app: string;
  readonly kind: TestTargetKind;
  readonly baseUrl: string;
  readonly capabilities: TestTargetCapabilities;

  stop(): Promise<void>;
}

/** Local built-server target lookup. */
export interface LocalBuildTestTargetRequest {
  readonly kind: "local-build";
  readonly app: string;
  readonly port?: number;
  /** Complete environment for the local build and server processes. */
  readonly startEnv?: NodeJS.ProcessEnv;
}

/** Local dev-server target lookup. */
export interface LocalDevTestTargetRequest {
  readonly kind: "local-dev";
  readonly app: string;
  readonly port?: number;
  /** Complete environment for the local dev server process. */
  readonly startEnv?: NodeJS.ProcessEnv;
}

/** Target lookup accepted by a local environment. */
export type LocalTestTargetRequest = LocalBuildTestTargetRequest | LocalDevTestTargetRequest;

/** Resolver for locally hosted smoke targets. */
export interface LocalTestEnvironment {
  readonly kind: "local";
  target(input: LocalTestTargetRequest): Promise<TestTarget>;
  stop(): Promise<void>;
}

/**
 * Collection of target resolvers for one smoke run.
 *
 * Local environments start or reuse loopback processes.
 */
export type TestEnvironment = LocalTestEnvironment;

/** Options for creating a local smoke-test environment. */
export interface CreateLocalTestEnvironmentOptions {
  /** First port assigned to local targets whose request omits `port`. */
  readonly firstPort?: number;

  /** Server starter override for tests. Defaults to the smoke server starter. */
  readonly startServer?: StartTestAgentServer;
}
