import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach } from "vitest";
import { resolvePackageRoot } from "#internal/application/package.js";

interface CreateTemporaryAppRootOptions {
  readonly packageName?: string;
  readonly packageType?: "module" | "commonjs";
  readonly files?: Readonly<Record<string, string>>;
}

interface TemporaryAppRoot {
  readonly appRoot: string;
  readonly agentRoot: string;
}

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
        } catch {}
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

    await mkdir(join(appRoot, "node_modules"), { recursive: true });
    await symlink(resolvePackageRoot(), join(appRoot, "node_modules", "eve"), "junction");

    return {
      agentRoot,
      appRoot,
    };
  };
}

export function useTemporaryDirectories(
  options: { readonly scope?: "file" | "test" } = {},
): (prefix: string) => Promise<string> {
  const temporaryRoots: string[] = [];

  (options.scope === "file" ? afterAll : afterEach)(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map(async (directoryPath) => {
        try {
          await rm(directoryPath, {
            force: true,
            recursive: true,
          });
        } catch {}
      }),
    );
  });

  return async (prefix) => {
    const root = await mkdtemp(join(tmpdir(), prefix));
    temporaryRoots.push(root);
    return root;
  };
}
