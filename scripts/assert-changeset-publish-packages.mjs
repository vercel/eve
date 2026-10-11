import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const allowedPublicPackages = new Set(["eve"]);
const workspaceRoots = ["apps", "packages"];

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function readWorkspacePackageJsonPaths() {
  const packageJsonPaths = ["package.json"];

  for (const root of workspaceRoots) {
    const entries = await readdir(root, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const packageJsonPath = join(root, entry.name, "package.json");

        if (await pathExists(packageJsonPath)) {
          packageJsonPaths.push(packageJsonPath);
        }
      }
    }
  }

  return packageJsonPaths;
}

const disallowedPublicPackages = [];

for (const packageJsonPath of await readWorkspacePackageJsonPaths()) {
  const packageJson = await readJson(packageJsonPath);

  if (packageJson.private === true || allowedPublicPackages.has(packageJson.name)) {
    continue;
  }

  disallowedPublicPackages.push({
    name: packageJson.name,
    path: packageJsonPath,
  });
}

if (disallowedPublicPackages.length > 0) {
  const packageList = disallowedPublicPackages
    .map((pkg) => `- ${pkg.name} (${pkg.path})`)
    .join("\n");

  throw new Error(
    [
      `Changesets publishing is restricted to: ${[...allowedPublicPackages].sort().join(", ")}.`,
      "Mark these packages private or add them to the explicit allow-list before releasing:",
      packageList,
    ].join("\n"),
  );
}
