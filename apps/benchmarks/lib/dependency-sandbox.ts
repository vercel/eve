import type { HarnessV1SandboxProvider } from "@ai-sdk/harness";
import { createVercelSandbox } from "@ai-sdk/sandbox-vercel";
import { Sandbox } from "@vercel/sandbox";

import { SOURCE_ARCHIVE_PATH, SOURCE_ROOT } from "./paths.js";

const dependencySnapshots = new Map<string, Promise<string>>();
const subjectSnapshots = new Map<string, Promise<string>>();

export function createDependencyCachedSandbox(options: {
  readonly archive: Uint8Array;
  readonly dependencyDigest: string;
  readonly ports: ReadonlyArray<number>;
  readonly env: Readonly<Record<string, string>>;
  readonly log: (message: string) => void;
}): HarnessV1SandboxProvider {
  const sessionProvider = (snapshotId: string) =>
    createVercelSandbox({
      source: { type: "snapshot", snapshotId },
      ports: [...options.ports],
      timeout: 15 * 60_000,
      env: { ...options.env },
      networkPolicy: "allow-all",
    });

  return {
    specificationVersion: "harness-sandbox-v1",
    providerId: "eve-benchmark-vercel",
    async createSession(request = {}) {
      options.log("[setup] preparing dependency cache");
      const dependencies = await dependencySnapshot(
        options.archive,
        options.dependencyDigest,
        options.log,
      );
      if (request.identity === undefined || request.onFirstCreate === undefined) {
        return sessionProvider(dependencies).createSession(request);
      }
      const subject = await subjectSnapshot(
        dependencies,
        request.identity,
        options.env,
        request.onFirstCreate,
        request.abortSignal,
      );
      return sessionProvider(subject).createSession({
        sessionId: request.sessionId,
        abortSignal: request.abortSignal,
      });
    },
    async resumeSession(request) {
      const dependencies = await dependencySnapshot(
        options.archive,
        options.dependencyDigest,
        options.log,
      );
      const provider = sessionProvider(dependencies);
      if (provider.resumeSession === undefined) {
        throw new Error("Vercel Sandbox does not support session resume.");
      }
      return provider.resumeSession(request);
    },
  };
}

function dependencySnapshot(
  archive: Uint8Array,
  digest: string,
  log: (message: string) => void,
): Promise<string> {
  const name = `eve-benchmark-dependencies-v4-${digest.slice(0, 24)}`;
  let snapshot = dependencySnapshots.get(name);
  if (snapshot !== undefined) return snapshot;
  snapshot = createDependencySnapshot(name, archive, log);
  dependencySnapshots.set(name, snapshot);
  return snapshot;
}

async function createDependencySnapshot(
  name: string,
  archive: Uint8Array,
  log: (message: string) => void,
): Promise<string> {
  let created = false;
  const sandbox = await Sandbox.getOrCreate({
    name,
    runtime: "node24",
    timeout: 15 * 60_000,
    persistent: true,
    snapshotExpiration: 0,
    networkPolicy: "allow-all",
    async onCreate(current) {
      created = true;
      log("[setup] fetching workspace dependencies");
      await current.writeFiles([{ path: SOURCE_ARCHIVE_PATH, content: archive }]);
      const command = await current.runCommand("bash", [
        "-lc",
        `mkdir -p ${SOURCE_ROOT} && tar -xzf ${SOURCE_ARCHIVE_PATH} -C ${SOURCE_ROOT} && npm install --global pnpm@11.15.0 vitest@4.1.10 && cd ${SOURCE_ROOT} && pnpm fetch --frozen-lockfile`,
      ]);
      if (command.exitCode !== 0) {
        throw new Error(
          `Dependency setup failed (${command.exitCode}):\n${await command.stdout()}\n${await command.stderr()}`,
        );
      }
    },
  });
  if (!created && sandbox.currentSnapshotId !== undefined) return sandbox.currentSnapshotId;
  return stopWithSnapshot(sandbox, "Dependency");
}

// Publish bootstrap mutations explicitly; a layered Vercel template can expose
// its inherited snapshot ID before those mutations receive a new snapshot.
function subjectSnapshot(
  dependencySnapshotId: string,
  identity: string,
  env: Readonly<Record<string, string>>,
  bootstrap: NonNullable<
    NonNullable<Parameters<HarnessV1SandboxProvider["createSession"]>[0]>["onFirstCreate"]
  >,
  abortSignal?: AbortSignal,
): Promise<string> {
  const name = `eve-benchmark-subject-${identity}`;
  let snapshot = subjectSnapshots.get(name);
  if (snapshot !== undefined) return snapshot;
  snapshot = createSubjectSnapshot(name, dependencySnapshotId, env, bootstrap, abortSignal);
  subjectSnapshots.set(name, snapshot);
  return snapshot;
}

async function createSubjectSnapshot(
  name: string,
  dependencySnapshotId: string,
  env: Readonly<Record<string, string>>,
  bootstrap: NonNullable<
    NonNullable<Parameters<HarnessV1SandboxProvider["createSession"]>[0]>["onFirstCreate"]
  >,
  abortSignal?: AbortSignal,
): Promise<string> {
  let created = false;
  const sandbox = await Sandbox.getOrCreate({
    name,
    source: { type: "snapshot", snapshotId: dependencySnapshotId },
    timeout: 15 * 60_000,
    env: { ...env },
    persistent: true,
    snapshotExpiration: 0,
    networkPolicy: "allow-all",
    signal: abortSignal,
    async onCreate(current) {
      created = true;
      const provider = createVercelSandbox({ sandbox: current });
      const session = await provider.createSession({ abortSignal });
      await bootstrap(session.restricted(), { abortSignal });
    },
  });
  if (!created && sandbox.currentSnapshotId !== undefined) return sandbox.currentSnapshotId;
  return stopWithSnapshot(sandbox, "Subject", abortSignal);
}

async function stopWithSnapshot(
  sandbox: Sandbox,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  const stopped = await sandbox.stop(signal === undefined ? undefined : { signal });
  const snapshotId = stopped.snapshot?.id ?? sandbox.currentSnapshotId;
  if (snapshotId === undefined) throw new Error(`${label} snapshot was not published.`);
  return snapshotId;
}
