import type { HarnessV1SandboxProvider } from "@ai-sdk/harness";
import { createVercelSandbox } from "@ai-sdk/sandbox-vercel";
import { Sandbox } from "@vercel/sandbox";

import { SOURCE_ARCHIVE_PATH, SOURCE_ROOT } from "./paths.js";

const snapshots = new Map<string, Promise<string>>();

export function createDependencyCachedSandbox(options: {
  readonly archive: Uint8Array;
  readonly dependencyDigest: string;
  readonly ports: ReadonlyArray<number>;
  readonly env: Readonly<Record<string, string>>;
  readonly log: (message: string) => void;
}): HarnessV1SandboxProvider {
  let provider: Promise<HarnessV1SandboxProvider> | undefined;
  const resolveProvider = () => {
    options.log("[setup] preparing dependency cache");
    return (provider ??= dependencySnapshot(
      options.archive,
      options.dependencyDigest,
      options.log,
    ).then((snapshotId) =>
      createVercelSandbox({
        source: { type: "snapshot", snapshotId },
        ports: [...options.ports],
        timeout: 15 * 60_000,
        env: { ...options.env },
        networkPolicy: "allow-all",
      }),
    ));
  };
  return {
    specificationVersion: "harness-sandbox-v1",
    providerId: "eve-benchmark-vercel",
    async createSession(options) {
      return (await resolveProvider()).createSession(options);
    },
    async resumeSession(options) {
      const resolved = await resolveProvider();
      if (resolved.resumeSession === undefined) {
        throw new Error("Vercel Sandbox does not support session resume.");
      }
      return resolved.resumeSession(options);
    },
  };
}

function dependencySnapshot(
  archive: Uint8Array,
  digest: string,
  log: (message: string) => void,
): Promise<string> {
  const name = `eve-benchmark-dependencies-${digest.slice(0, 24)}`;
  let snapshot = snapshots.get(name);
  if (snapshot !== undefined) return snapshot;
  snapshot = createDependencySnapshot(name, archive, log);
  snapshots.set(name, snapshot);
  return snapshot;
}

async function createDependencySnapshot(
  name: string,
  archive: Uint8Array,
  log: (message: string) => void,
): Promise<string> {
  const sandbox = await Sandbox.getOrCreate({
    name,
    runtime: "node24",
    timeout: 15 * 60_000,
    persistent: true,
    snapshotExpiration: 0,
    networkPolicy: "allow-all",
    async onCreate(created) {
      log("[setup] fetching workspace dependencies");
      await created.writeFiles([{ path: SOURCE_ARCHIVE_PATH, content: archive }]);
      const command = await created.runCommand("bash", [
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
  if (sandbox.currentSnapshotId !== undefined) return sandbox.currentSnapshotId;
  const stopped = await sandbox.stop();
  if (stopped.snapshot?.id === undefined) throw new Error("Dependency snapshot was not published.");
  return stopped.snapshot.id;
}
