import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { runPack } from "./package-publish-report.mjs";

const execFile = promisify(execFileCallback);

const INIT_PROJECT_NAME = "my-agent";
const INIT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const INSTALLED_PACKAGE_BREAKDOWN_MAX_ENTRIES = 6;
const INSTALLED_PACKAGE_BREAKDOWN_MIN_BYTES = 5_000_000;

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

function comparePaths(left, right) {
  return left.localeCompare(right, "en");
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  const source = await readFile(path, "utf8");

  return JSON.parse(source);
}

async function walkRegularFiles(root) {
  /** @type {{ relativePath: string; size: number }[]} */
  const files = [];

  async function visit(currentPath) {
    const entries = await readdir(currentPath, {
      withFileTypes: true,
    });
    entries.sort((left, right) => comparePaths(left.name, right.name));

    for (const entry of entries) {
      const entryPath = join(currentPath, entry.name);

      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const entryStats = await stat(entryPath);
      files.push({
        relativePath: normalizePath(relative(root, entryPath)),
        size: entryStats.size,
      });
    }
  }

  await visit(root);
  files.sort((left, right) => comparePaths(left.relativePath, right.relativePath));

  return files;
}

function readInstalledPackageName(relativePath) {
  const pathSegments = normalizePath(relativePath).split("/");
  let packageStartIndex = 0;

  for (const [index, segment] of pathSegments.entries()) {
    if (segment === "node_modules" && index + 1 < pathSegments.length) {
      packageStartIndex = index + 1;
    }
  }

  const packageStart = pathSegments[packageStartIndex];

  if (!packageStart || packageStart.startsWith(".")) {
    return null;
  }

  if (packageStart.startsWith("@")) {
    const scopedName = pathSegments[packageStartIndex + 1];

    return scopedName ? `${packageStart}/${scopedName}` : null;
  }

  return packageStart;
}

function summarizeInstalledPackages(files) {
  /** @type {Map<string, number>} */
  const packageSizes = new Map();

  for (const file of files) {
    const packageName = readInstalledPackageName(file.relativePath);

    if (!packageName) {
      continue;
    }

    packageSizes.set(packageName, (packageSizes.get(packageName) ?? 0) + file.size);
  }

  const sortedPackages = [...packageSizes.entries()]
    .sort((left, right) => right[1] - left[1] || comparePaths(left[0], right[0]))
    .map(([name, bytes]) => ({
      bytes,
      name,
    }));

  if (sortedPackages.length <= INSTALLED_PACKAGE_BREAKDOWN_MAX_ENTRIES) {
    return sortedPackages;
  }

  let retainedCount = INSTALLED_PACKAGE_BREAKDOWN_MAX_ENTRIES;

  while (
    retainedCount < sortedPackages.length &&
    sortedPackages[retainedCount] &&
    sortedPackages[retainedCount].bytes > INSTALLED_PACKAGE_BREAKDOWN_MIN_BYTES
  ) {
    retainedCount += 1;
  }

  return sortedPackages.slice(0, retainedCount);
}

function readDependencyBlock(packageJson, key) {
  return Object.entries(packageJson[key] ?? {})
    .filter((entry) => typeof entry[1] === "string")
    .map(([name, range]) => ({
      name,
      range,
    }))
    .sort((left, right) => comparePaths(left.name, right.name));
}

function attachInstalledBytes(dependencies, packageSizes) {
  return dependencies.map((dependency) => ({
    ...dependency,
    bytes: packageSizes.get(dependency.name) ?? 0,
  }));
}

function normalizeDependencyRanges(dependencies, input) {
  return dependencies.map((dependency) =>
    dependency.name === input.packageName && dependency.range.startsWith("file:")
      ? { ...dependency, range: input.packageSpec }
      : dependency,
  );
}

async function runInitCommand(input) {
  const packageRoot = resolve(input.packageRoot);
  const cliPath = join(packageRoot, "bin", "eve.js");

  if (!(await pathExists(cliPath))) {
    return null;
  }

  await execFile(process.execPath, [cliPath, "init", INIT_PROJECT_NAME], {
    cwd: input.parentDirectory,
    env: {
      ...process.env,
      CODEX_CI: "1",
      EVE_INIT_PACKAGE_SPEC: input.evePackageSpec,
      npm_config_user_agent: `npm/? node/${process.versions.node} ${process.platform} ${process.arch}`,
    },
    maxBuffer: 32 * 1024 * 1024,
    timeout: INIT_INSTALL_TIMEOUT_MS,
  });

  return true;
}

export async function collectInitInstallReportFromTarball(options) {
  const packageRoot = resolve(options.packageRoot);
  const initDirectory = await mkdtemp(join(tmpdir(), "eve-init-install-"));

  try {
    const initialized = await runInitCommand({
      evePackageSpec: `file:${options.tarballPath}`,
      packageRoot,
      parentDirectory: initDirectory,
    });
    if (initialized !== true) {
      return null;
    }

    const projectRoot = join(initDirectory, INIT_PROJECT_NAME);
    const packageJson = await readJson(join(projectRoot, "package.json"));
    const nodeModulesRoot = join(projectRoot, "node_modules");
    const installedFiles = (await pathExists(nodeModulesRoot))
      ? await walkRegularFiles(nodeModulesRoot)
      : [];
    const installedSizeBytes = installedFiles.reduce((total, file) => total + file.size, 0);
    const packageSizes = new Map();
    const packageSpec = `file:${basename(options.tarballPath)}`;

    for (const file of installedFiles) {
      const packageName = readInstalledPackageName(file.relativePath);

      if (!packageName) {
        continue;
      }

      packageSizes.set(packageName, (packageSizes.get(packageName) ?? 0) + file.size);
    }

    const dependencies = normalizeDependencyRanges(
      attachInstalledBytes(readDependencyBlock(packageJson, "dependencies"), packageSizes),
      {
        packageName: "eve",
        packageSpec,
      },
    );
    const devDependencies = normalizeDependencyRanges(
      attachInstalledBytes(readDependencyBlock(packageJson, "devDependencies"), packageSizes),
      {
        packageName: "eve",
        packageSpec,
      },
    );
    const directDependencyNames = new Set(dependencies.map((dependency) => dependency.name));
    const directDevDependencyNames = new Set(devDependencies.map((dependency) => dependency.name));
    const dependencyPackageBytes = dependencies.reduce(
      (total, dependency) => total + dependency.bytes,
      0,
    );
    const devDependencyPackageBytes = devDependencies.reduce(
      (total, dependency) =>
        directDependencyNames.has(dependency.name) ? total : total + dependency.bytes,
      0,
    );

    return {
      dependencyCount: dependencies.length,
      dependencyPackageBytes,
      dependencies,
      devDependencies,
      devDependencyCount: devDependencies.length,
      devDependencyPackageBytes,
      installedFileCount: installedFiles.length,
      installedPackageCount: packageSizes.size,
      installedSizeBytes,
      packageLabel: options.packageLabel ?? basename(packageRoot),
      packageRoot,
      packageSpec,
      packageManager: "npm",
      projectName: INIT_PROJECT_NAME,
      topInstalledPackages: summarizeInstalledPackages(installedFiles),
      transitivePackageBytes: Math.max(
        0,
        installedSizeBytes - dependencyPackageBytes - devDependencyPackageBytes,
      ),
      unclassifiedInstalledPackageCount: [...packageSizes.keys()].filter(
        (name) => !directDependencyNames.has(name) && !directDevDependencyNames.has(name),
      ).length,
    };
  } finally {
    await rm(initDirectory, {
      force: true,
      recursive: true,
    });
  }
}

export async function collectInitInstallReport(options) {
  const packageRoot = resolve(options.packageRoot);
  const packDirectory = await mkdtemp(join(tmpdir(), "eve-init-package-pack-"));

  try {
    const packResult = await runPack(packageRoot, packDirectory);
    const tarballFilename = typeof packResult.filename === "string" ? packResult.filename : null;

    if (!tarballFilename) {
      throw new Error(`npm pack did not report a tarball filename for "${packageRoot}".`);
    }

    return collectInitInstallReportFromTarball({
      packageLabel: options.packageLabel,
      packageRoot,
      tarballPath: join(packDirectory, tarballFilename),
    });
  } finally {
    await rm(packDirectory, {
      force: true,
      recursive: true,
    });
  }
}
