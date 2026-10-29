import { execFileSync } from "node:child_process";
import { access, cp, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCatalogReferences } from "./package-catalog.mjs";

const root = resolve(process.argv[2] ?? ".");
if (
  process.env.npm_lifecycle_event === "prepack" &&
  (process.env.npm_config_user_agent ?? "").startsWith("npm/")
) {
  throw new Error(
    "Run pnpm pack in the package directory, or npm pack in the staged .package directory.",
  );
}
const target = join(root, ".package");
const marker = ".eve-package-stage";
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const staging = await mkdtemp(join(root, ".package-staging-"));
try {
  for (const name of new Set([
    ...manifest.files.filter((file) => !file.startsWith("!")),
    "README.md",
    "LICENSE",
  ])) {
    if (name === "CHANGELOG.md") continue;
    if (!/^[\w./-]+$/u.test(name) || name.startsWith("/") || name.split("/").includes("..")) {
      throw new Error(`Cannot stage package file pattern ${JSON.stringify(name)}.`);
    }
    try {
      await cp(join(root, name), join(staging, name), { recursive: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const { manifest: resolvedManifest } = await resolveCatalogReferences(root, manifest);
  const stagedManifest = {
    ...resolvedManifest,
    files: [...new Set([...manifest.files, "!dist/CHANGELOG.md", "CHANGELOG.md"])],
  };
  stagedManifest.publishConfig = { ...manifest.publishConfig };
  delete stagedManifest.publishConfig.directory;
  delete stagedManifest.publishConfig.linkDirectory;
  stagedManifest.scripts = { ...manifest.scripts };
  delete stagedManifest.scripts.prepack;
  delete stagedManifest.scripts.postpack;
  await writeFile(join(staging, "package.json"), `${JSON.stringify(stagedManifest, null, 2)}\n`);
  execFileSync(
    process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), "write-package-changelog.mjs"), root, staging],
    { stdio: "inherit" },
  );
  await writeFile(join(staging, marker), "");
  try {
    await access(target);
    await access(join(target, marker));
    await rm(target, { recursive: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    try {
      await access(target);
      throw new Error(`Refusing to overwrite unmanaged package staging directory ${target}.`);
    } catch (missing) {
      if (missing?.code !== "ENOENT") throw missing;
    }
  }
  await rename(staging, target);
} finally {
  await rm(staging, { recursive: true, force: true });
}
