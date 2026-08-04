import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BuzzRoute } from "./types.js";

export interface PublicationReservation {
  commit(): Promise<void>;
  markUnknown(): Promise<void>;
  release(): Promise<void>;
}

export type PublicationState = PublicationReservation | "published" | "unknown";

export function publicationKey(route: BuzzRoute): string {
  if (!route.replyTo) throw new Error("Buzz reply routes require an event anchor");
  return createHash("sha256").update(`${route.channelId}\0${route.replyTo}`).digest("hex");
}

export async function reservePublication(options: {
  directory: string;
  key: string;
  staleAfterMs: number;
}): Promise<PublicationState> {
  await mkdir(options.directory, { recursive: true });
  const lock = join(options.directory, `${options.key}.lock`);
  const published = join(options.directory, `${options.key}.published`);
  const unknown = join(options.directory, `${options.key}.unknown`);

  if (await exists(published)) return "published";
  if (await exists(unknown)) return "unknown";

  try {
    const handle = await open(lock, "wx");
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
    await handle.close();
  } catch (error) {
    if (!isExistsError(error)) throw error;
    if (await exists(published)) return "published";
    if (await exists(unknown)) return "unknown";
    let age: number;
    try {
      age = Date.now() - (await stat(lock)).mtimeMs;
    } catch (statError) {
      if (isNotFoundError(statError)) return reservePublication(options);
      throw statError;
    }
    if (age < options.staleAfterMs) {
      throw new Error("A Buzz reply for this event is already being published");
    }
    await rm(lock, { force: true });
    return reservePublication(options);
  }

  return {
    async commit() {
      await rename(lock, published);
    },
    async markUnknown() {
      await rename(lock, unknown);
    },
    async release() {
      await rm(lock, { force: true });
    },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

function isExistsError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
