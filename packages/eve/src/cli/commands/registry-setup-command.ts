import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "#compiled/zod/index.js";

export interface RegistrySetupCommand {
  package: string;
  bin: string;
  args: string[];
}

export type RegistrySetupCommandResult = "completed" | "cancelled";

const PackageJsonSchema = z.object({
  name: z.string().min(1),
  bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
});

type PackageJson = z.infer<typeof PackageJsonSchema>;

function declaredBinPath(packageJson: PackageJson, binName: string): string | undefined {
  if (typeof packageJson.bin === "string") {
    const defaultBinName = packageJson.name.slice(packageJson.name.lastIndexOf("/") + 1);
    return binName === defaultBinName ? packageJson.bin : undefined;
  }
  return packageJson.bin?.[binName];
}

async function resolveNodePackageBin(packageJsonPath: string, binName: string): Promise<string> {
  const packageRoot = dirname(packageJsonPath);
  const packageJson = PackageJsonSchema.parse(JSON.parse(await readFile(packageJsonPath, "utf8")));
  const declaredPath = declaredBinPath(packageJson, binName);
  if (declaredPath === undefined) {
    throw new Error(`Package "${packageJson.name}" does not declare a "${binName}" binary.`);
  }

  const executable = resolve(packageRoot, declaredPath);
  const packageRelativePath = relative(packageRoot, executable);
  if (packageRelativePath.startsWith("..") || isAbsolute(packageRelativePath)) {
    throw new Error(
      `Package "${packageJson.name}" declares its "${binName}" binary outside the package directory.`,
    );
  }
  return executable;
}

/** Executes a trusted registry setup command from an installed package's declared Node binary. */
export async function runRegistrySetupCommand(
  appRoot: string,
  setup: RegistrySetupCommand,
  item: string,
): Promise<RegistrySetupCommandResult> {
  const packageJsonPath = findPackageJSON(
    setup.package,
    pathToFileURL(resolve(appRoot, "package.json")),
  );
  if (packageJsonPath === undefined) {
    throw new Error(
      `Setup package "${setup.package}" is not installed. Run \`eve add ${item}\` first.`,
    );
  }
  const executable = await resolveNodePackageBin(packageJsonPath, setup.bin);

  return new Promise<RegistrySetupCommandResult>((resolveResult, reject) => {
    const child = spawn(process.execPath, [executable, ...setup.args], {
      cwd: appRoot,
      env: { ...process.env, EVE_SETUP: "1", EVE_SETUP_ITEM: item },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveResult("completed");
        return;
      }
      if (code === 130 || signal === "SIGINT") {
        resolveResult("cancelled");
        return;
      }
      reject(
        new Error(
          signal === null
            ? `Setup command exited with code ${code ?? "unknown"}.`
            : `Setup command was terminated by ${signal}.`,
        ),
      );
    });
  });
}
