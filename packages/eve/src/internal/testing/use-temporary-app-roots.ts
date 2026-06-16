import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach } from "vitest";

/**
 * Options accepted by the factory returned from
 * {@link useTemporaryAppRoots}.
 */
export interface CreateTemporaryAppRootOptions {
  /** Value written into the synthetic `package.json#name`. */
  readonly packageName?: string;
  /** Value written into the synthetic `package.json#type`. */
  readonly packageType?: "module" | "commonjs";
  /**
   * Extra files to write under the app root, keyed by POSIX-relative path.
   * Parent directories are created automatically.
   */
  readonly files?: Readonly<Record<string, string>>;
}

/**
 * Handle returned by the {@link useTemporaryAppRoots} factory.
 */
export interface TemporaryAppRoot {
  /** Absolute path to the temporary app root. */
  readonly appRoot: string;
  /**
   * Absolute path to `${appRoot}/agent` (the nested layout agent root).
   * Created empty unless the caller writes files into it.
   */
  readonly agentRoot: string;
}

/**
 * Registers an `afterEach` hook and returns a factory that creates fresh
 * temporary app roots with an empty nested-layout `agent/` directory.
 */
export function useTemporaryAppRoots(): (
  prefix: string,
  options?: CreateTemporaryAppRootOptions,
) => Promise<TemporaryAppRoot> {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map(async (directoryPath) => {
        try {
          await rm(directoryPath, {
            force: true,
            recursive: true,
          });
        } catch {
          // Best-effort cleanup; a leaked tmpdir must not fail the run.
        }
      }),
    );
  });

  return async (prefix, options = {}) => {
    const appRoot = await mkdtemp(join(tmpdir(), prefix));
    const agentRoot = join(appRoot, "agent");

    temporaryRoots.push(appRoot);
    await mkdir(agentRoot, {
      recursive: true,
    });

    const packageJson: Record<string, unknown> = {
      name: options.packageName ?? "eve-test-agent",
      type: options.packageType ?? "module",
    };

    await writeFile(
      join(appRoot, "package.json"),
      `${JSON.stringify(packageJson, null, 2)}\n`,
      "utf8",
    );

    for (const [relativePath, contents] of Object.entries(options.files ?? {})) {
      const destinationPath = join(appRoot, relativePath);

      await mkdir(join(destinationPath, ".."), {
        recursive: true,
      });
      await writeFile(destinationPath, contents, "utf8");
    }

    return {
      agentRoot,
      appRoot,
    };
  };
}

/**
 * Registers an `afterEach` hook and returns a factory that creates fresh
 * temporary scratch directories.
 */
export function useTemporaryDirectories(): (prefix: string) => Promise<string> {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map(async (directoryPath) => {
        try {
          await rm(directoryPath, {
            force: true,
            recursive: true,
          });
        } catch {
          // Best-effort cleanup.
        }
      }),
    );
  });

  return async (prefix) => {
    const root = await mkdtemp(join(tmpdir(), prefix));
    temporaryRoots.push(root);
    return root;
  };
}
