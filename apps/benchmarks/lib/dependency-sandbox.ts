import type { HarnessV1SandboxProvider } from "@ai-sdk/harness";
import { createVercelSandbox } from "@ai-sdk/sandbox-vercel";
import { Sandbox } from "@vercel/sandbox";

import { SOURCE_ARCHIVE_PATH, SOURCE_ROOT } from "./paths.js";

const dependencySnapshots = new Map<string, Promise<string>>();
const subjectSnapshots = new Map<string, Promise<string>>();

type SandboxCredentials = { token: string; teamId: string; projectId: string };

function sandboxCredentials(): SandboxCredentials {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_ORG_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (token === undefined || teamId === undefined || projectId === undefined) {
    throw new Error(
      "Benchmarks require VERCEL_TOKEN, VERCEL_ORG_ID, and VERCEL_PROJECT_ID to create Vercel Sandboxes.",
    );
  }
  return { token, teamId, projectId };
}

export function createDependencyCachedSandbox(options: {
  readonly archive: Uint8Array;
  readonly dependencyDigest: string;
  readonly ports: ReadonlyArray<number>;
  readonly env: Readonly<Record<string, string>>;
  readonly log: (message: string) => void;
}): HarnessV1SandboxProvider {
  const credentials = sandboxCredentials();
  const sessionProvider = (snapshotId?: string) =>
    snapshotId === undefined
      ? createVercelSandbox({
          ...credentials,
          runtime: "node24",
          ports: [...options.ports],
          timeout: 15 * 60_000,
          env: { ...options.env },
          networkPolicy: "allow-all",
        })
      : createVercelSandbox({
          ...credentials,
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
      if (request.identity === undefined || request.onFirstCreate === undefined) {
        return sessionProvider().createSession(request);
      }
      options.log("[setup] preparing dependency cache");
      const dependencySnapshotId = await dependencySnapshot(
        options.archive,
        options.dependencyDigest,
        options.log,
        credentials,
      );
      const subjectSnapshotId = await subjectSnapshot(
        dependencySnapshotId,
        request.identity,
        options.env,
        request.onFirstCreate,
        request.abortSignal,
        credentials,
      );
      return sessionProvider(subjectSnapshotId).createSession({
        abortSignal: request.abortSignal,
      });
    },
    async resumeSession(request) {
      const provider = sessionProvider();
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
  credentials: SandboxCredentials,
): Promise<string> {
  const name = `eve-benchmark-dependencies-${digest.slice(0, 24)}`;
  let snapshot = dependencySnapshots.get(name);
  if (snapshot !== undefined) return snapshot;
  snapshot = createDependencySnapshot(name, archive, log, credentials);
  dependencySnapshots.set(name, snapshot);
  return snapshot;
}

async function createDependencySnapshot(
  name: string,
  archive: Uint8Array,
  log: (message: string) => void,
  credentials: SandboxCredentials,
): Promise<string> {
  let created = false;
  const sandbox = await Sandbox.getOrCreate({
    ...credentials,
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

function subjectSnapshot(
  dependencySnapshotId: string,
  identity: string,
  env: Readonly<Record<string, string>>,
  bootstrap: NonNullable<Parameters<HarnessV1SandboxProvider["createSession"]>[0]>["onFirstCreate"],
  abortSignal: AbortSignal | undefined,
  credentials: SandboxCredentials,
): Promise<string> {
  const name = `eve-benchmark-subject-${identity}`;
  let snapshot = subjectSnapshots.get(name);
  if (snapshot !== undefined) return snapshot;
  snapshot = createSubjectSnapshot(
    name,
    dependencySnapshotId,
    env,
    bootstrap,
    abortSignal,
    credentials,
  );
  subjectSnapshots.set(name, snapshot);
  return snapshot;
}

async function createSubjectSnapshot(
  name: string,
  dependencySnapshotId: string,
  env: Readonly<Record<string, string>>,
  bootstrap: NonNullable<Parameters<HarnessV1SandboxProvider["createSession"]>[0]>["onFirstCreate"],
  abortSignal: AbortSignal | undefined,
  credentials: SandboxCredentials,
): Promise<string> {
  let created = false;
  const sandbox = await Sandbox.getOrCreate({
    ...credentials,
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
      await bootstrap!(session.restricted(), { abortSignal });
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
