import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export function resolveFileUrlModule(id: string, importer?: string): string | undefined {
  if (
    importer?.startsWith("file://") &&
    !id.startsWith(".") &&
    !id.startsWith("/") &&
    !id.startsWith("\0") &&
    !id.startsWith("node:")
  ) {
    try {
      return createRequire(importer).resolve(id);
    } catch {
      return undefined;
    }
  }

  const fileUrl = id.startsWith("file://")
    ? id
    : importer?.startsWith("file://") && id.startsWith(".")
      ? new URL(id, importer).href
      : undefined;
  if (fileUrl === undefined) {
    return undefined;
  }

  const url = new URL(fileUrl);
  const suffix = `${url.search}${url.hash}`;
  url.search = "";
  url.hash = "";
  return `${fileURLToPath(url)}${suffix}`;
}

export async function loadFileUrlModule(id: string): Promise<string | undefined> {
  if (!id.startsWith("file://")) {
    return undefined;
  }

  return await readFile(new URL(id), "utf8");
}
