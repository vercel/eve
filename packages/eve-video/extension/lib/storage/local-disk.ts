import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { mediaTypeForPath } from "../media.ts";
import { normalizeStorageKey } from "./key.ts";
import type { VideoStorage } from "./types.ts";

/** Configuration options for {@link localDisk}. */
export interface LocalDiskVideoStorageOptions {
  /** Root directory where videos are stored. Defaults to a temporary `eve-videos` directory. */
  readonly directory?: string;
  /** Optional `http://` or `https://` base URL exposed for stored files. */
  readonly publicBaseUrl?: string;
}

/** Creates a local filesystem video storage adapter with atomic writes. */
export function localDisk(options: LocalDiskVideoStorageOptions = {}): VideoStorage {
  if (options.directory !== undefined && !options.directory.trim())
    throw new TypeError("Local disk directory cannot be empty.");
  const root =
    options.directory === undefined
      ? resolve(join(tmpdir(), "eve-videos"))
      : resolve(options.directory);
  let publicBaseUrl: string | undefined;
  if (options.publicBaseUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(options.publicBaseUrl);
    } catch {
      throw new TypeError(`Invalid publicBaseUrl "${options.publicBaseUrl}".`);
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.search ||
      parsed.hash
    ) {
      throw new TypeError(`Invalid publicBaseUrl "${options.publicBaseUrl}".`);
    }
    publicBaseUrl = parsed.toString().replace(/\/+$/, "");
  }
  const targetFor = (rawKey: string) => {
    const key = normalizeStorageKey(rawKey);
    const target = resolve(root, ...key.split("/"));
    const rel = relative(root, target);
    if (
      !rel ||
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      rel.startsWith("../") ||
      isAbsolute(rel)
    ) {
      throw new TypeError(`Video storage key "${rawKey}" escapes storage directory.`);
    }
    return { key, target };
  };

  return {
    async put({ key: rawKey, data, mediaType, signal }) {
      signal.throwIfAborted();
      const { key, target } = targetFor(rawKey);
      await mkdir(dirname(target), { recursive: true });
      const tmp = join(dirname(target), `.tmp-${randomUUID()}`);
      try {
        await writeFile(tmp, data, { signal });
        signal.throwIfAborted();
        await rename(tmp, target);
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => {});
        throw error;
      }
      return {
        key,
        path: target,
        mediaType,
        bytes: data.byteLength,
        ...(publicBaseUrl && { url: `${publicBaseUrl}/${key}`, visibility: "public" as const }),
      };
    },
    async get({ key: rawKey, signal }) {
      signal.throwIfAborted();
      const { key, target } = targetFor(rawKey);
      try {
        const buf = await readFile(target, { signal });
        const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        return {
          key,
          data,
          mediaType: mediaTypeForPath(key) ?? "application/octet-stream",
          bytes: data.byteLength,
        };
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
    },
    async delete({ key, signal }) {
      signal.throwIfAborted();
      await rm(targetFor(key).target, { force: true });
    },
  };
}
