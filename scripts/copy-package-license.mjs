import { copyFile, readFile, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const monorepoRoot = fileURLToPath(new URL("..", import.meta.url));
const copiedLicense = "Apache-2.0";

/**
 * Files copied verbatim from the monorepo root into each package at
 * `prepack` so they ship in the npm tarball. LICENSE is auto-included
 * by npm; NOTICE must also travel with the package (Apache-2.0 §4(d))
 * but is only packed when present in the package directory.
 */
const COPIED_FILES = ["LICENSE", "NOTICE"];

const sourceTexts = new Map();
for (const fileName of COPIED_FILES) {
  sourceTexts.set(fileName, await readFile(join(monorepoRoot, fileName), "utf8"));
}

async function readPackageJson(packageRoot) {
  const packageJsonPath = join(packageRoot, "package.json");
  return JSON.parse(await readFile(packageJsonPath, "utf8"));
}

async function cleanPackageFile(packageRoot, fileName, destinationPath) {
  let packageFileText;

  try {
    packageFileText = await readFile(destinationPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }

    throw error;
  }

  if (packageFileText !== sourceTexts.get(fileName)) {
    throw new Error(
      `Refusing to remove ${relative(monorepoRoot, destinationPath)} because it does not match the root ${fileName}.`,
    );
  }

  await rm(destinationPath);
  console.log(`Removed ${fileName} from ${relative(monorepoRoot, packageRoot)}`);
}

const args = process.argv.slice(2);
const clean = args[0] === "--clean";
const packageRootArgs = clean ? args.slice(1) : args;

if (packageRootArgs.length === 0) {
  throw new Error("Pass at least one package directory.");
}

const packageRoots = packageRootArgs.map((arg) => resolve(process.cwd(), arg));

for (const packageRoot of packageRoots) {
  const packageJson = await readPackageJson(packageRoot);

  if (packageJson.license !== copiedLicense) {
    throw new Error(
      `Cannot ${clean ? "remove" : "copy"} ${copiedLicense} LICENSE for ${packageJson.name}; package.json declares ${packageJson.license ?? "no license"}.`,
    );
  }

  for (const fileName of COPIED_FILES) {
    const destinationPath = join(packageRoot, fileName);

    if (clean) {
      await cleanPackageFile(packageRoot, fileName, destinationPath);
      continue;
    }

    await copyFile(join(monorepoRoot, fileName), destinationPath);
    console.log(`Copied ${fileName} to ${relative(monorepoRoot, destinationPath)}`);
  }
}
