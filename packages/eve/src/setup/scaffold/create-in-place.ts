import { readdir } from "node:fs/promises";

import { pathExists } from "./files.js";

const ALLOWED_CREATE_IN_PLACE_ENTRIES = new Set([
  ".DS_Store",
  ".git",
  ".gitkeep",
  ".hg",
  // These committed manifests may establish the development environment before init can run.
  ".node-version",
  ".nvmrc",
  ".protolock",
  ".prototools",
  ".tool-versions",
  "devenv.lock",
  "devenv.nix",
  "devenv.yaml",
  "devbox.json",
  "devbox.lock",
  "flake.lock",
  "flake.nix",
]);

function isSharedMiseEntry(entry: string): boolean {
  const filename = entry.startsWith(".") ? entry.slice(1) : entry;
  const segments = filename.split(".");
  const extension = segments.at(-1);
  const variants = segments.slice(1, -1);
  return (
    segments[0] === "mise" &&
    (extension === "toml" || extension === "lock") &&
    variants.every((variant) => variant !== "" && variant !== "local")
  );
}

export function blockingCreateInPlaceEntries(entries: readonly string[]): string[] {
  return entries.filter(
    (entry) => !ALLOWED_CREATE_IN_PLACE_ENTRIES.has(entry) && !isSharedMiseEntry(entry),
  );
}

export async function assertCanCreateInPlace(
  targetRoot: string,
  overwriteExisting: boolean,
): Promise<void> {
  if (!(await pathExists(targetRoot))) {
    return;
  }

  const entries = await readdir(targetRoot);
  const blocking = blockingCreateInPlaceEntries(entries);
  if (blocking.length > 0 && !overwriteExisting) {
    const visible = blocking.slice(0, 5).join(", ");
    const suffix = blocking.length > 5 ? `, and ${blocking.length - 5} more` : "";
    throw new Error(
      `Cannot create project in current directory because it is not empty. Found: ${visible}${suffix}. Use an empty directory.`,
    );
  }
}
