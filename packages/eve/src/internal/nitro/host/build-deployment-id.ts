import { createHash } from "node:crypto";

import { BUILD_DEPLOYMENT_ID_PATTERN } from "#execution/install-workflow-deployment-id.js";

export const BUILD_DEPLOYMENT_ID_PLACEHOLDER = "eve_BUILD_DEPLOYMENT_ID_PLACEHOLDER_";
const READ_AHEAD = 16;

export interface BuildDeploymentFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

/** Hashes files in path order while holding at most `READ_AHEAD` files in memory. */
export async function computeBuildDeploymentId(
  relativePaths: readonly string[],
  readBytes: (relativePath: string) => Promise<Uint8Array>,
  extraInputs: readonly string[] = [],
): Promise<string> {
  const hash = createHash("sha256");
  const append = (bytes: Uint8Array) => {
    hash.update(`${bytes.byteLength}:`);
    hash.update(bytes);
  };
  hash.update("eve-build-v1\0");
  // Nitro writes a build timestamp to the root nitro.json; nothing reads it at runtime.
  const paths = relativePaths
    .filter((path) => path !== "nitro.json")
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const reads: Promise<Uint8Array>[] = [];
  const startRead = (index: number) => {
    if (index >= paths.length) return;
    const read = readBytes(paths[index]!);
    // Reads ahead may reject after an earlier read already failed the hash.
    read.catch(() => undefined);
    reads[index] = read;
  };
  for (let index = 0; index < READ_AHEAD; index++) startRead(index);
  for (let index = 0; index < paths.length; index++) {
    const bytes = await reads[index]!;
    delete reads[index];
    startRead(index + READ_AHEAD);
    hash.update("file\0");
    append(Buffer.from(paths[index]!));
    append(bytes);
  }
  for (const input of [...extraInputs].sort()) {
    hash.update("input\0");
    append(Buffer.from(input));
  }
  return `eve_${hash.digest("hex").slice(0, 32)}`;
}

export function replaceBuildDeploymentId(
  files: readonly BuildDeploymentFile[],
  deploymentId: string,
): BuildDeploymentFile {
  const placeholder = Buffer.from(BUILD_DEPLOYMENT_ID_PLACEHOLDER);
  const replacement = Buffer.from(deploymentId);
  if (
    !BUILD_DEPLOYMENT_ID_PATTERN.test(deploymentId) ||
    replacement.length !== placeholder.length
  ) {
    throw new Error(
      "Invalid build deployment id: expected eve_ followed by 32 lowercase hex characters.",
    );
  }
  let match: { file: BuildDeploymentFile; offset: number } | undefined;
  let count = 0;
  for (const file of files) {
    const bytes = Buffer.from(file.bytes);
    for (
      let offset = bytes.indexOf(placeholder);
      offset !== -1;
      offset = bytes.indexOf(placeholder, offset + placeholder.length)
    ) {
      count++;
      match = { file, offset };
    }
  }
  if (count !== 1 || match === undefined) {
    throw new Error(
      `Cannot install build deployment id: expected exactly one workflow-world placeholder in server/**/*.mjs outside node_modules, found ${count}. This is an eve bug; please report it.`,
    );
  }
  const bytes = Buffer.from(match.file.bytes);
  replacement.copy(bytes, match.offset);
  return { relativePath: match.file.relativePath, bytes };
}
