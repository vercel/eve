/**
 * Contentful mirror sync: reads page entries from the CMA and writes them to a
 * mirror workspace. Storage is injected so this module stays independent of Drives.
 *
 * @packageDocumentation
 */

import { z } from "zod";

import { callApi } from "../api";
import { configuredSpaces, configurationKey } from "../config";
import { entryStatus } from "../content";
import { projectEntryLocale, withContentfulLocale } from "../locale";
import { spacePath } from "../model";
import type { RawSpaceUser } from "../query";
import type { Collection, RawContentType, RawEntry } from "../types";
import { MIRROR_DATABASE_FILE, MIRROR_DATABASE_PATH } from "./database";
import {
  MIRROR_MANIFEST_PATH,
  MIRROR_SCHEMA_PATH,
  MIRROR_USERS_PATH,
  mirrorDataPath,
  mirrorFilePath,
  parseMirrorManifest,
  renderMirrorData,
  renderMirrorFile,
  renderSchemaLines,
  renderUserLines,
} from "./files";
import type { MirrorManifest } from "./files";

/* Entries per CMA page. */
const PAGE_SIZE = 100;

/* Incremental syncs re-read this much before the last sync start to absorb clock skew. */
const INCREMENTAL_OVERLAP_MS = 10 * 60 * 1000;

/*
 * Version of the files a sync writes. Bump it whenever entries gain or change files so the
 * first sync after an upgrade rewrites every entry; version 2 added JSON sidecars, the schema
 * file, and the database.
 */
const MIRROR_FORMAT = 2;

/**
 * Identifies the deployment configuration and file format that produced a mirror.
 *
 * @returns The value stored in the manifest; a different value forces a full sync.
 */
export const mirrorConfigurationKey = (): string =>
  JSON.stringify({ configuration: configurationKey(), format: MIRROR_FORMAT });

/* File storage the sync writes to; paths are absolute mirror paths. */
/**
 * File storage required by mirror sync; all paths are absolute paths within the mirror mount.
 */
export interface MirrorWorkspace {
  /** Every mirrored entry file currently stored. */
  listEntryFiles: () => Promise<string[]>;
  readText: (path: string) => Promise<string | null>;
  /** Remove files; missing files are ignored. */
  remove: (paths: string[]) => Promise<void>;
  /** Write files, creating parent directories. */
  writeFiles: (files: { content: string; path: string }[]) => Promise<void>;
  /**
   * Optionally rebuild the compacted SQL database from the files just written.
   * Called after all entry changes and before the manifest is committed.
   */
  buildDatabase?: () => Promise<void>;
}

/* Run the optional database build; a failure keeps the sync and drops the stale database. */
const rebuildDatabase = async (
  workspace: MirrorWorkspace
): Promise<string | undefined> => {
  if (!workspace.buildDatabase) {
    return undefined;
  }
  const started = Date.now();
  try {
    await workspace.buildDatabase();
    console.info("contentful.mirror_database_built", {
      elapsedMs: Date.now() - started,
    });
    return MIRROR_DATABASE_FILE;
  } catch (error) {
    console.error("contentful.mirror_database_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    try {
      await workspace.remove([MIRROR_DATABASE_PATH]);
    } catch {
      // The manifest will not list the database, so readers fall back to the files either way.
    }
    return undefined;
  }
};

/**
 * `incremental` updates entries changed since the last sync. `full` rewrites every
 * entry and removes files for entries that no longer exist.
 */
export type MirrorSyncMode = "incremental" | "full";

interface MirrorSyncResult {
  entryCount: number;
  /** The mode that ran; an incremental request without a valid manifest runs full. */
  mode: MirrorSyncMode;
  removed: number;
  syncedAt: string;
  written: number;
}

/**
 * Yields CMA `skip` offsets until the caller stops paginating.
 *
 * @param size - Page size each offset advances by.
 * @returns An endless sequence of offsets starting at zero.
 */
const pageOffsets = function* pageOffsets(size = PAGE_SIZE) {
  for (let skip = 0; ; skip += size) {
    yield skip;
  }
};

/* Content types per CMA page; the API's maximum, so most spaces need one request. */
const CONTENT_TYPE_PAGE_SIZE = 1000;

/**
 * Reads every content type in every configured space as newline-delimited JSON.
 *
 * @param signal - Cancellation signal shared by the CMA reads.
 * @returns Schema lines for all spaces and the number of content types they describe.
 */
const readSchemas = async (signal?: AbortSignal) => {
  let text = "";
  let count = 0;
  for await (const spaceId of new Set(Object.values(configuredSpaces()))) {
    for await (const skip of pageOffsets(CONTENT_TYPE_PAGE_SIZE)) {
      signal?.throwIfAborted();
      const page = await callApi<Collection<RawContentType>>(
        `${spacePath(spaceId)}/content_types`,
        {
          limit: String(CONTENT_TYPE_PAGE_SIZE),
          order: "sys.id",
          skip: String(skip),
        },
        signal
      );
      text += renderSchemaLines(spaceId, page.items);
      count += page.items.length;
      const more =
        page.total === undefined
          ? page.items.length === CONTENT_TYPE_PAGE_SIZE
          : page.total > skip + page.items.length;
      if (!more || page.items.length === 0) {
        break;
      }
    }
  }
  return { count, text };
};

/**
 * Reads the users of every configured space as newline-delimited JSON.
 *
 * @param signal - Cancellation signal shared by the CMA reads.
 * @returns User lines for all spaces and the number of users they describe.
 * @throws {@link Error} When any space's listing fails, so a partial file never replaces a complete one.
 * @remarks Users belong to the space, not an environment. Users repeated across pages are written once per space.
 */
const readUsers = async (signal?: AbortSignal) => {
  let text = "";
  let count = 0;
  for await (const spaceId of new Set(Object.values(configuredSpaces()))) {
    const users = new Map<string, RawSpaceUser>();
    for await (const skip of pageOffsets()) {
      signal?.throwIfAborted();
      const page = await callApi<Collection<RawSpaceUser>>(
        `/spaces/${spaceId}/users`,
        { limit: String(PAGE_SIZE), skip: String(skip) },
        signal
      );
      for (const user of page.items) {
        users.set(user.sys.id, user);
      }
      const more =
        page.total === undefined
          ? page.items.length === PAGE_SIZE
          : page.total > skip + page.items.length;
      if (!more || page.items.length === 0) {
        break;
      }
    }
    const lines = renderUserLines(spaceId, [...users.values()]);
    text += lines;
    count += lines.split("\n").length - 1;
  }
  return { count, text };
};

/* The part of a users file line needed to tell which space it belongs to. */
const userLineSpace = z.object({ space: z.string() });

/* Keeps the previous users file's lines for spaces that are still configured. */
const configuredUserLines = (previous: string) => {
  const spaces = new Set(Object.values(configuredSpaces()));
  return previous
    .split("\n")
    .filter((line) => {
      try {
        const parsed = userLineSpace.safeParse(JSON.parse(line));
        return parsed.success && spaces.has(parsed.data.space);
      } catch {
        return false;
      }
    })
    .map((line) => `${line}\n`)
    .join("");
};

/**
 * Writes the users file, keeping the previous one when the CMA cannot list users.
 *
 * @param workspace - Mirror storage receiving the users file.
 * @param signal - Cancellation signal; an abort still fails the sync.
 * @returns Number of users written, or null when listing failed.
 * @remarks A failed listing, such as a token without permission to read space users, is logged and does not fail the sync. The previous file is kept without the users of spaces that are no longer configured, or replaced by an empty file when there is none, so the database build still finds it.
 */
const syncUsers = async (
  workspace: MirrorWorkspace,
  signal?: AbortSignal
): Promise<number | null> => {
  let users: { count: number; text: string };
  try {
    users = await readUsers(signal);
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    console.warn("contentful.mirror_users_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    const previous = await workspace.readText(MIRROR_USERS_PATH);
    await workspace.writeFiles([
      {
        content: previous === null ? "" : configuredUserLines(previous),
        path: MIRROR_USERS_PATH,
      },
    ]);
    return null;
  }
  await workspace.writeFiles([
    { content: users.text, path: MIRROR_USERS_PATH },
  ]);
  return users.count;
};

/**
 * Yields CMA pages for every configured space, including archived entries for removal.
 *
 * @param since - Earliest update timestamp to include; null reads every entry.
 * @param signal - Cancellation signal shared by paginated CMA reads.
 * @returns An asynchronous stream of entries grouped by their raw space ID.
 * @remarks Immutable creation-time ordering prevents edits from shifting later pages.
 */
const entryPages = async function* entryPages(
  since: string | null,
  signal?: AbortSignal
): AsyncGenerator<{ entries: RawEntry[]; kind: string }> {
  for await (const spaceId of new Set(Object.values(configuredSpaces()))) {
    const kind = spaceId;
    for await (const skip of pageOffsets()) {
      signal?.throwIfAborted();

      const page = await callApi<Collection<RawEntry>>(
        `${spacePath(spaceId)}/entries`,
        {
          limit: String(PAGE_SIZE),
          order: "sys.createdAt,sys.id",
          skip: String(skip),
          ...(since && { "sys.updatedAt[gte]": since }),
        },
        signal
      );
      yield { entries: page.items, kind };
      const more =
        page.total === undefined
          ? page.items.length === PAGE_SIZE
          : page.total > skip + page.items.length;
      if (!more || page.items.length === 0) {
        break;
      }
    }
  }
};

/**
 * Writes live entry files and removes archived entries from each fetched page.
 *
 * @param workspace - Mirror storage receiving file updates and removals.
 * @param since - Earliest update timestamp to include; null processes all entries.
 * @param signal - Cancellation signal for fetching and rendering pages.
 * @returns Current entry paths and counts of files written or removed.
 */
const applyEntryPages = async (
  workspace: MirrorWorkspace,
  since: string | null,
  signal?: AbortSignal
) => {
  const current = new Set<string>();
  let written = 0;
  let removed = 0;
  for await (const { entries, kind } of entryPages(since, signal)) {
    const counts = await withContentfulLocale(
      kind,
      async () => {
        const files: { content: string; path: string }[] = [];
        const archived: string[] = [];
        for await (const entry of entries) {
          const path = mirrorFilePath(kind, entry.sys.id);
          if (!path) {
            continue;
          }
          if (entryStatus(entry.sys) === "archived") {
            archived.push(path, mirrorDataPath(path));
          } else {
            current.add(path);
            const projected = await projectEntryLocale(
              spacePath(kind),
              entry,
              signal
            );
            files.push(
              { content: renderMirrorFile(projected, kind), path },
              {
                content: renderMirrorData(projected, kind),
                path: mirrorDataPath(path),
              }
            );
          }
        }
        if (files.length) {
          await workspace.writeFiles(files);
        }
        if (archived.length) {
          await workspace.remove(archived);
        }
        // Counts are per entry; each entry has a Markdown file and a JSON sidecar.
        return { removed: archived.length / 2, written: files.length / 2 };
      },
      signal
    );
    written += counts.written;
    removed += counts.removed;
  }
  return { current, removed, written };
};

/**
 * Reconciles the mirror with Contentful and commits its manifest after all file changes succeed.
 *
 * @param options - Workspace, requested mode, optional sync-start time, and cancellation signal.
 * @returns Effective sync mode, final entry count, timestamp, and write/removal totals.
 * @throws {@link Error} When configuration, a CMA request, or a workspace operation fails.
 * @remarks Invalid or changed configuration, or a mirror written in an older file format, forces a full sync. A failed sync leaves the previous manifest unchanged. Every sync rewrites the content types and space users before building the database; the `contentful.mirror_sync` log reports `userCount` as null when users could not be listed, in which case the previous users file is kept.
 */
export const syncContentfulMirror = async ({
  mode,
  now = new Date(),
  signal,
  workspace,
}: {
  mode: MirrorSyncMode;
  now?: Date;
  signal?: AbortSignal;
  workspace: MirrorWorkspace;
}): Promise<MirrorSyncResult> => {
  if (!Object.keys(configuredSpaces()).length) {
    throw new Error("Set CONTENTFUL_SPACE_IDS before syncing the mirror.");
  }
  const configuration = mirrorConfigurationKey();
  const started = Date.now();
  const syncedAt = now.toISOString();
  const previous = parseMirrorManifest(
    await workspace.readText(MIRROR_MANIFEST_PATH)
  );
  const effectiveMode =
    previous?.configuration === configuration ? mode : "full";
  const since =
    effectiveMode === "incremental" && previous
      ? new Date(
          Date.parse(previous.syncedAt) - INCREMENTAL_OVERLAP_MS
        ).toISOString()
      : null;

  const { current, removed, written } = await applyEntryPages(
    workspace,
    since,
    signal
  );

  // Only a full sync knows every current entry, so only it can find deleted ones.
  const existingPaths = await workspace.listEntryFiles();
  const stale =
    effectiveMode === "full"
      ? existingPaths.filter((path) => !current.has(path))
      : [];
  if (stale.length) {
    await workspace.remove(
      stale.flatMap((path) => [path, mirrorDataPath(path)])
    );
  }
  const entryCount =
    effectiveMode === "full" ? current.size : existingPaths.length;
  // Content models change rarely, but every sync rewrites them so the schema tables match the entries.
  const schemas = await readSchemas(signal);
  await workspace.writeFiles([
    { content: schemas.text, path: MIRROR_SCHEMA_PATH },
  ]);
  const userCount = await syncUsers(workspace, signal);
  const database = await rebuildDatabase(workspace);
  const manifest: MirrorManifest = {
    configuration,
    ...(database && { database }),
    entryCount,
    fullSyncedAt:
      previous && effectiveMode === "incremental"
        ? previous.fullSyncedAt
        : syncedAt,
    syncedAt,
    version: 1,
  };
  await workspace.writeFiles([
    {
      content: `${JSON.stringify(manifest, null, 2)}\n`,
      path: MIRROR_MANIFEST_PATH,
    },
  ]);
  const result = {
    entryCount,
    mode: effectiveMode,
    removed: removed + stale.length,
    syncedAt,
    written,
  };
  console.info("contentful.mirror_sync", {
    ...result,
    contentTypeCount: schemas.count,
    elapsedMs: Date.now() - started,
    userCount,
  });
  return result;
};
