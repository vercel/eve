import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

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

function readRuntimeDependencies(packageJson) {
  return Object.entries(packageJson.dependencies ?? {})
    .map(([name, range]) => ({
      name,
      range,
    }))
    .sort((left, right) => comparePaths(left.name, right.name));
}

function readPeerDependencies(packageJson) {
  return Object.entries(packageJson.peerDependencies ?? {})
    .map(([name, range]) => ({
      name,
      optional: packageJson.peerDependenciesMeta?.[name]?.optional === true,
      range,
    }))
    .sort((left, right) => comparePaths(left.name, right.name));
}

const INSTALLED_PACKAGE_BREAKDOWN_MAX_ENTRIES = 6;
const INSTALLED_PACKAGE_BREAKDOWN_MIN_BYTES = 5_000_000;

function summarizeTopPublishedFiles(files, count) {
  return [...files]
    .sort((left, right) => right.size - left.size || comparePaths(left.path, right.path))
    .slice(0, count)
    .map((file) => ({
      bytes: file.size,
      path: file.path,
    }));
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

function summarizeInstalledPackages(files, options) {
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

  if (sortedPackages.length <= options.maxEntries) {
    return sortedPackages;
  }

  let retainedCount = options.maxEntries;

  while (
    retainedCount < sortedPackages.length &&
    sortedPackages[retainedCount] &&
    sortedPackages[retainedCount].bytes > options.minBytes
  ) {
    retainedCount += 1;
  }

  return sortedPackages.slice(0, retainedCount);
}

function parsePackOutput(stdout, stderr, packageRoot) {
  const trimmedStdout = stdout.trim();
  const directJsonSource = trimmedStdout === "" ? "[]" : trimmedStdout;

  try {
    return JSON.parse(directJsonSource);
  } catch (directParseError) {
    const trailingJsonMatch = trimmedStdout.match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/);

    if (trailingJsonMatch?.[1]) {
      return JSON.parse(trailingJsonMatch[1]);
    }

    const stderrText = stderr.trim();
    throw new Error(
      [
        `Failed to parse npm pack output for "${packageRoot}".`,
        directParseError instanceof Error ? directParseError.message : String(directParseError),
        stderrText === "" ? null : stderrText,
      ]
        .filter((value) => value !== null)
        .join("\n"),
    );
  }
}

/*
 * Walks up from `startDirectory` to find the nearest `pnpm-workspace.yaml`,
 * parses its top-level `catalog:` block, and returns a map of dependency
 * name → version range. Returns an empty map if no workspace file is found
 * or it has no catalog. Uses a minimal line-based parser because we control
 * the file's shape and don't want to add a YAML dependency.
 */
async function readWorkspaceCatalog(startDirectory) {
  let currentDirectory = resolve(startDirectory);

  while (true) {
    const candidate = join(currentDirectory, "pnpm-workspace.yaml");

    if (await pathExists(candidate)) {
      const source = await readFile(candidate, "utf8");
      const lines = source.split(/\r?\n/);
      const catalog = new Map();
      let inCatalogBlock = false;

      for (const line of lines) {
        if (/^catalog:\s*$/.test(line)) {
          inCatalogBlock = true;
          continue;
        }

        if (inCatalogBlock) {
          if (/^\S/.test(line)) {
            break;
          }

          const match = line.match(/^\s+"?([^":\s]+)"?:\s*"?([^"\s]+)"?\s*$/);

          if (match) {
            catalog.set(match[1], match[2]);
          }
        }
      }

      return catalog;
    }

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return new Map();
    }

    currentDirectory = parentDirectory;
  }
}

/*
 * Returns a manifest with all `catalog:` references resolved to concrete
 * versions from the workspace catalog, plus a flag indicating whether any
 * rewrite was needed.
 */
async function resolveCatalogReferences(packageRoot, manifest) {
  const depTypes = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

  let hasCatalogReference = false;

  outer: for (const depType of depTypes) {
    const block = manifest[depType];

    if (!block || typeof block !== "object") {
      continue;
    }

    for (const range of Object.values(block)) {
      if (typeof range === "string" && range.startsWith("catalog:")) {
        hasCatalogReference = true;
        break outer;
      }
    }
  }

  if (!hasCatalogReference) {
    return {
      manifest,
      rewrote: false,
    };
  }

  const catalog = await readWorkspaceCatalog(packageRoot);
  const rewritten = JSON.parse(JSON.stringify(manifest));

  for (const depType of depTypes) {
    const block = rewritten[depType];

    if (!block || typeof block !== "object") {
      continue;
    }

    for (const [name, range] of Object.entries(block)) {
      if (typeof range !== "string" || !range.startsWith("catalog:")) {
        continue;
      }

      const resolved = catalog.get(name);

      if (!resolved) {
        throw new Error(
          `Dependency "${name}" in "${packageRoot}/package.json" uses "${range}" but is not defined in the workspace catalog.`,
        );
      }

      block[name] = resolved;
    }
  }

  return {
    manifest: rewritten,
    rewrote: true,
  };
}

/*
 * Replaces `catalog:` references inside an already-packed npm tarball with
 * concrete versions from the workspace catalog. The tarball is extracted to
 * a temp dir, its `package/package.json` is rewritten, and the tarball is
 * recreated in place. The source `package.json` on disk is never touched —
 * earlier attempts that rewrote it before pack sometimes leaked resolved
 * specifiers into pnpm-lock.yaml when a concurrent pnpm command happened to
 * read the manifest mid-rewrite.
 */
async function rewriteCatalogReferencesInTarball(tarballPath, packageRoot) {
  const stagingDirectory = await mkdtemp(join(tmpdir(), "eve-package-rewrite-"));

  try {
    await execFile("tar", ["-xzf", tarballPath, "-C", stagingDirectory], {
      maxBuffer: 16 * 1024 * 1024,
    });

    const packageDirectory = join(stagingDirectory, "package");
    const manifestPath = join(packageDirectory, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const { manifest: resolvedManifest, rewrote } = await resolveCatalogReferences(
      packageRoot,
      manifest,
    );

    if (!rewrote) {
      return;
    }

    await writeFile(manifestPath, `${JSON.stringify(resolvedManifest, null, 2)}\n`, "utf8");
    await execFile("tar", ["-czf", tarballPath, "-C", stagingDirectory, "package"], {
      maxBuffer: 16 * 1024 * 1024,
    });
  } finally {
    await rm(stagingDirectory, {
      force: true,
      recursive: true,
    });
  }
}

export async function runPack(packageRoot, packDirectory) {
  const packagePath = resolve(packageRoot);
  const { stderr, stdout } = await execFile(
    "npm",
    ["pack", "--json", "--pack-destination", packDirectory],
    {
      cwd: packagePath,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const results = parsePackOutput(stdout, stderr, packagePath);
  const packResult = Array.isArray(results) ? results[0] : null;

  if (!packResult || typeof packResult !== "object") {
    throw new Error(`Expected one pack result for "${packagePath}".`);
  }

  /*
   * `npm pack` doesn't understand pnpm's `catalog:` protocol, so any
   * `catalog:` ranges in the source manifest end up verbatim inside the
   * tarball — which then breaks `npm install` of that tarball with
   * `EUNSUPPORTEDPROTOCOL`. Rewrite the tarball's manifest to use the
   * concrete versions from the workspace catalog. When the source manifest
   * has no `catalog:` references this is a no-op.
   */
  if (typeof packResult.filename === "string") {
    const tarballPath = resolve(packDirectory, packResult.filename);

    await rewriteCatalogReferencesInTarball(tarballPath, packagePath);
    /*
     * Re-stat the tarball — rewriting the bundled manifest can change the
     * gzipped size that npm originally reported.
     */
    try {
      packResult.size = (await stat(tarballPath)).size;
    } catch {}
  }

  return packResult;
}

async function collectInstalledPackageSnapshot(input) {
  const installRoot = input.installRoot;
  await mkdir(installRoot, {
    recursive: true,
  });
  await writeFile(
    join(installRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "eve-package-install-footprint",
        private: true,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await execFile(
    "npm",
    ["install", "--ignore-scripts", "--no-package-lock", "--no-save", resolve(input.tarballPath)],
    {
      cwd: installRoot,
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  const nodeModulesRoot = join(installRoot, "node_modules");
  const installedFiles = (await pathExists(nodeModulesRoot))
    ? await walkRegularFiles(nodeModulesRoot)
    : [];
  const installedSizeBytes = installedFiles.reduce((total, file) => total + file.size, 0);
  const installedPackageBytes = installedFiles.reduce((total, file) => {
    return readInstalledPackageName(file.relativePath) === input.packageName
      ? total + file.size
      : total;
  }, 0);

  return {
    installedDependencyBytes: installedSizeBytes - installedPackageBytes,
    installedFileCount: installedFiles.length,
    installedPackageBytes,
    installedSizeBytes,
    topInstalledPackages: summarizeInstalledPackages(installedFiles, {
      maxEntries: INSTALLED_PACKAGE_BREAKDOWN_MAX_ENTRIES,
      minBytes: INSTALLED_PACKAGE_BREAKDOWN_MIN_BYTES,
    }),
  };
}

export async function collectPublishedPackageReportFromPack(options) {
  const packageRoot = resolve(options.packageRoot);
  const packageJson = await readJson(resolve(packageRoot, "package.json"));
  const packageName =
    typeof packageJson.name === "string" ? packageJson.name : basename(packageRoot);
  const runtimeDependencies = readRuntimeDependencies(packageJson);
  const peerDependencies = readPeerDependencies(packageJson);
  const packResult = options.packResult;
  const tarballFilename = typeof packResult.filename === "string" ? packResult.filename : null;

  if (!tarballFilename) {
    throw new Error(`npm pack did not report a tarball filename for "${packageRoot}".`);
  }

  const packedFiles = Array.isArray(packResult.files)
    ? packResult.files
        .filter(
          (file) =>
            file &&
            typeof file === "object" &&
            typeof file.path === "string" &&
            typeof file.size === "number",
        )
        .map((file) => ({
          path: file.path,
          size: file.size,
        }))
    : [];
  const installedSnapshot = await collectInstalledPackageSnapshot({
    installRoot: options.installDirectory,
    packageName,
    tarballPath: options.tarballPath,
  });

  return {
    installedDependencyBytes: installedSnapshot.installedDependencyBytes,
    installedFileCount: installedSnapshot.installedFileCount,
    installedPackageBytes: installedSnapshot.installedPackageBytes,
    installedSizeBytes: installedSnapshot.installedSizeBytes,
    packageLabel: options.packageLabel ?? basename(packageRoot),
    packageName,
    packageRoot,
    packedSizeBytes: typeof packResult.size === "number" ? packResult.size : 0,
    peerDependencies,
    publishedFileCount: typeof packResult.entryCount === "number" ? packResult.entryCount : 0,
    tarballFilename,
    topInstalledPackages: installedSnapshot.topInstalledPackages,
    topPublishedFiles: summarizeTopPublishedFiles(packedFiles, 5),
    unpackedSizeBytes: typeof packResult.unpackedSize === "number" ? packResult.unpackedSize : 0,
    version: typeof packageJson.version === "string" ? packageJson.version : "0.0.0",
    runtimeDependencies,
  };
}

/**
 * Collects one package publish report from the package manifest and an
 * isolated pack/install snapshot.
 */
export async function collectPublishedPackageReport(options) {
  const packageRoot = resolve(options.packageRoot);
  const packDirectory = await mkdtemp(join(tmpdir(), "eve-package-pack-"));
  const installDirectory = await mkdtemp(join(tmpdir(), "eve-package-install-"));

  try {
    const packResult = await runPack(packageRoot, packDirectory);
    const tarballFilename = typeof packResult.filename === "string" ? packResult.filename : null;

    if (!tarballFilename) {
      throw new Error(`npm pack did not report a tarball filename for "${packageRoot}".`);
    }

    return collectPublishedPackageReportFromPack({
      installDirectory,
      packageLabel: options.packageLabel,
      packageRoot,
      packResult,
      tarballPath: join(packDirectory, tarballFilename),
    });
  } finally {
    await Promise.all([
      rm(packDirectory, {
        force: true,
        recursive: true,
      }),
      rm(installDirectory, {
        force: true,
        recursive: true,
      }),
    ]);
  }
}
