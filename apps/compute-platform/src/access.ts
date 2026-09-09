import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { hashComputeCredential } from "eve/internal/compute-platform";

import { computePlatformConfig, requireComputeToken } from "./config.ts";

export const localAccessFilePath =
  process.env.EVE_COMPUTE_ACCESS_FILE ??
  fileURLToPath(new URL("../.eve/compute-access.json", import.meta.url));

export async function writeLocalComputeAccessFile(): Promise<string> {
  const contents = [
    {
      credentialHash: hashComputeCredential(requireComputeToken()),
      namespaceId: computePlatformConfig.namespaceId,
      permissions: ["send", "read", "operate", "deploy"],
      principalId: "local-developer",
    },
  ];
  await mkdir(dirname(localAccessFilePath), { recursive: true });
  await chmod(localAccessFilePath, 0o600).catch(() => {});
  await writeFile(localAccessFilePath, `${JSON.stringify(contents, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(localAccessFilePath, 0o400);
  return localAccessFilePath;
}
