import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AgentServerHandle, type AgentServerMode, startAgentServer } from "../lib/server.ts";
import { DEFAULT_TEST_TARGET_CAPABILITIES } from "./capabilities.ts";
import { createTestTarget } from "./create-target.ts";
import type {
  CreateLocalTestEnvironmentOptions,
  LocalTestEnvironment,
  LocalTestTargetRequest,
  TestTarget,
} from "./types.ts";

const DEFAULT_LOCAL_TARGET_PORT = Number(process.env.PORT ?? 3000);

interface LocalTargetRecord {
  readonly startEnvKey: string;
  readonly target: TestTarget;
}

interface PendingLocalTargetRecord {
  readonly abort: () => void;
  readonly startEnvKey: string;
  readonly target: Promise<TestTarget>;
}

/** Creates an environment that starts local eve app servers on demand. */
export function createLocalTestEnvironment(
  options: CreateLocalTestEnvironmentOptions = {},
): LocalTestEnvironment {
  const startServer = options.startServer ?? startAgentServer;
  const firstPort = options.firstPort ?? DEFAULT_LOCAL_TARGET_PORT;
  let nextPort = firstPort;

  const records = new Map<string, LocalTargetRecord>();
  const pendingRecords = new Map<string, PendingLocalTargetRecord>();
  const defaultPortByTarget = new Map<string, number>();
  const portOwners = new Map<number, string>();
  const stoppingRecords = new Set<string>();
  const workflowDataDirsByTarget = new Map<string, string>();
  const ownedWorkflowDataDirs = new Set<string>();
  let stopped = false;

  const environment: LocalTestEnvironment = {
    kind: "local",
    async target(input) {
      if (stopped) {
        throw new Error("Local smoke test environment has already been stopped.");
      }

      const targetId = `${input.kind}:${input.app}`;
      const port = input.port ?? resolveDefaultPort({ defaultPortByTarget, targetId });
      if (input.port === undefined && port === nextPort) {
        nextPort += 1;
      }

      const key = `${targetId}:${port}`;
      const startupEnv = await snapshotStartupEnv(input.startEnv, {
        ownedWorkflowDataDirs,
        targetKey: key,
        workflowDataDirsByTarget,
      });
      const existing = records.get(key);
      if (existing !== undefined) {
        if (stoppingRecords.has(key)) {
          throw new Error(
            `Local smoke target "${input.app}" (${input.kind}) on port ${port} is already stopping.`,
          );
        }
        if (existing.startEnvKey !== startupEnv.key) {
          throw new Error(
            `Local smoke target "${input.app}" (${input.kind}) on port ${port} was already started with different startup env.`,
          );
        }
        return existing.target;
      }

      const pending = pendingRecords.get(key);
      if (pending !== undefined) {
        if (pending.startEnvKey !== startupEnv.key) {
          throw new Error(
            `Local smoke target "${input.app}" (${input.kind}) on port ${port} is already starting with different startup env.`,
          );
        }
        return pending.target;
      }

      const owner = portOwners.get(port);
      if (owner !== undefined && owner !== key) {
        throw new Error(
          `Local smoke target "${input.app}" (${input.kind}) requested port ${port}, but ${owner} already owns it.`,
        );
      }

      portOwners.set(port, key);
      const controller = new AbortController();
      const pendingRecord: PendingLocalTargetRecord = {
        abort: () => {
          controller.abort();
        },
        startEnvKey: startupEnv.key,
        target: startLocalTarget({
          input: { ...input, startEnv: startupEnv.env },
          key,
          port,
          signal: controller.signal,
          startEnvKey: startupEnv.key,
        }),
      };
      pendingRecords.set(key, pendingRecord);

      try {
        return await pendingRecord.target;
      } catch (error) {
        portOwners.delete(port);
        throw error;
      } finally {
        pendingRecords.delete(key);
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;

      for (const pending of pendingRecords.values()) {
        pending.abort();
      }
      try {
        const targets = new Set([
          ...[...records.values()].map((record) => record.target),
          ...(await resolvePendingTargets(pendingRecords)),
        ]);
        await Promise.all([...targets].map((target) => target.stop()));
      } finally {
        records.clear();
        pendingRecords.clear();
        portOwners.clear();
        defaultPortByTarget.clear();
        stoppingRecords.clear();
        workflowDataDirsByTarget.clear();
        const workflowDataDirs = [...ownedWorkflowDataDirs];
        ownedWorkflowDataDirs.clear();
        await Promise.all(
          workflowDataDirs.map((path) => rm(path, { force: true, recursive: true })),
        );
      }
    },
  };

  function resolveDefaultPort(input: {
    readonly defaultPortByTarget: Map<string, number>;
    readonly targetId: string;
  }): number {
    const existingPort = input.defaultPortByTarget.get(input.targetId);
    if (existingPort !== undefined) return existingPort;

    while (portOwners.has(nextPort)) {
      nextPort += 1;
    }

    input.defaultPortByTarget.set(input.targetId, nextPort);
    return nextPort;
  }

  async function startLocalTarget(input: {
    readonly input: LocalTestTargetRequest;
    readonly key: string;
    readonly port: number;
    readonly signal: AbortSignal;
    readonly startEnvKey: string;
  }): Promise<TestTarget> {
    const targetId = `${input.input.kind}:${input.input.app}`;
    const server = await startServerWithAbort({
      message: `Local smoke target "${input.input.app}" (${input.input.kind}) startup was aborted.`,
      signal: input.signal,
      start: () =>
        startServer({
          appName: input.input.app,
          mode: localTargetKindToServerMode(input.input.kind),
          port: input.port,
          signal: input.signal,
          startEnv: input.input.startEnv,
        }),
    });

    try {
      let stopPromise: Promise<void> | undefined;
      const target = createTestTarget({
        app: input.input.app,
        baseUrl: server.baseUrl,
        capabilities: DEFAULT_TEST_TARGET_CAPABILITIES[input.input.kind],
        kind: input.input.kind,
        stop: () => {
          if (stopPromise !== undefined) return stopPromise;
          stoppingRecords.add(input.key);
          stopPromise = (async () => {
            try {
              await server.stop();
              portOwners.delete(input.port);
            } catch (error) {
              defaultPortByTarget.delete(targetId);
              portOwners.set(input.port, `${input.key} (stop failed)`);
              throw error;
            } finally {
              records.delete(input.key);
              stoppingRecords.delete(input.key);
            }
          })();
          return stopPromise;
        },
      });

      records.set(input.key, { startEnvKey: input.startEnvKey, target });
      return target;
    } catch (error) {
      await server.stop();
      throw error;
    }
  }

  return environment;
}

async function snapshotStartupEnv(
  startEnv: NodeJS.ProcessEnv | undefined,
  options: {
    readonly ownedWorkflowDataDirs: Set<string>;
    readonly targetKey: string;
    readonly workflowDataDirsByTarget: Map<string, string>;
  },
): Promise<{
  readonly env: NodeJS.ProcessEnv;
  readonly key: string;
}> {
  const entries: Array<readonly [string, string]> = [];
  for (const [name, value] of Object.entries(startEnv ?? process.env)) {
    if (value !== undefined) {
      entries.push([name, value]);
    }
  }
  entries.sort(([left], [right]) => left.localeCompare(right));

  const env = {} as NodeJS.ProcessEnv;
  for (const [name, value] of entries) {
    env[name] = value;
  }

  if (env.WORKFLOW_LOCAL_DATA_DIR === undefined) {
    const workflowDataDir = await resolveOwnedWorkflowDataDir(options);
    env.WORKFLOW_LOCAL_DATA_DIR = workflowDataDir;
    entries.push(["WORKFLOW_LOCAL_DATA_DIR", workflowDataDir]);
    entries.sort(([left], [right]) => left.localeCompare(right));
  }

  return {
    env,
    key: JSON.stringify(entries),
  };
}

async function resolveOwnedWorkflowDataDir(input: {
  readonly ownedWorkflowDataDirs: Set<string>;
  readonly targetKey: string;
  readonly workflowDataDirsByTarget: Map<string, string>;
}): Promise<string> {
  const existing = input.workflowDataDirsByTarget.get(input.targetKey);
  if (existing !== undefined) return existing;

  const directory = await mkdtemp(join(tmpdir(), "eve-e2e-workflow-"));
  input.workflowDataDirsByTarget.set(input.targetKey, directory);
  input.ownedWorkflowDataDirs.add(directory);
  return directory;
}

class AbortedStartupCleanupError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "AbortedStartupCleanupError";
  }
}

function startServerWithAbort(input: {
  readonly message: string;
  readonly signal: AbortSignal;
  readonly start: () => Promise<AgentServerHandle>;
}): Promise<AgentServerHandle> {
  if (input.signal.aborted) {
    return Promise.reject(new Error(input.message));
  }

  const serverPromise = input.start();
  return new Promise((resolve, reject) => {
    let aborted = false;
    let settled = false;

    const cleanup = () => {
      input.signal.removeEventListener("abort", onAbort);
    };
    const settle = (finish: () => void): boolean => {
      if (settled) return false;
      settled = true;
      cleanup();
      finish();
      return true;
    };
    const rejectAborted = (): void => {
      aborted = true;
    };
    const onAbort = (): void => {
      rejectAborted();
    };

    serverPromise.then(
      async (server) => {
        if (aborted || input.signal.aborted) {
          try {
            await server.stop();
          } catch (error) {
            settle(() => reject(new AbortedStartupCleanupError(input.message, error)));
            return;
          }
          settle(() => reject(new Error(input.message)));
          return;
        }

        settle(() => resolve(server));
      },
      (error) => {
        if (aborted || input.signal.aborted) {
          settle(() => reject(new Error(input.message)));
          return;
        }

        settle(() => reject(error));
      },
    );

    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) onAbort();
  });
}

async function resolvePendingTargets(
  pendingRecords: ReadonlyMap<string, PendingLocalTargetRecord>,
): Promise<TestTarget[]> {
  const settled = await Promise.allSettled(
    [...pendingRecords.values()].map((record) => record.target),
  );
  const cleanupErrors = settled.flatMap((result) =>
    result.status === "rejected" && result.reason instanceof AbortedStartupCleanupError
      ? [result.reason]
      : [],
  );
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Failed to clean up aborted local smoke targets.");
  }
  return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

function localTargetKindToServerMode(kind: LocalTestTargetRequest["kind"]): AgentServerMode {
  switch (kind) {
    case "local-build":
      return "built";
    case "local-dev":
      return "dev";
  }
}
