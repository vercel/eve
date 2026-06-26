import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "#compiled/zod/index.js";
import { httpServerUrlSchema } from "#shared/network-address.js";

const STATE_FILE_NAME = "dev-server-state.v1.json";

const developmentServerStateSchema = z
  .object({
    url: httpServerUrlSchema,
  })
  .strict();

/**
 * The last ready development-server URL for one app root.
 *
 * The record lets a second interactive `eve dev` attach to the same server.
 * It is not a lock: a stale or malformed record simply causes the caller to
 * start a new server and overwrite it once that server is ready.
 */
export class DevelopmentServerState {
  readonly appRoot: string;
  readonly #stateDir: string;
  readonly #statePath: string;

  constructor(project: { readonly appRoot: string }) {
    this.appRoot = project.appRoot;
    this.#stateDir = join(this.appRoot, ".eve");
    this.#statePath = join(this.#stateDir, STATE_FILE_NAME);
  }

  /** Returns the recorded URL, if the record exists and is valid. */
  async read(): Promise<string | undefined> {
    let raw: string;

    try {
      raw = await readFile(this.#statePath, "utf8");
    } catch (error) {
      if (isErrnoException(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }

    try {
      const parsed = developmentServerStateSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data.url : undefined;
    } catch {
      return undefined;
    }
  }

  /** Records a server after it is ready to accept clients. */
  async write(url: string): Promise<void> {
    const state = developmentServerStateSchema.parse({ url });
    await mkdir(this.#stateDir, { recursive: true });
    await writeFile(this.#statePath, `${JSON.stringify(state)}\n`, "utf8");
  }

  /** Clears the record after the listening server has stopped. */
  async remove(): Promise<void> {
    await rm(this.#statePath, { force: true });
  }
}

function isErrnoException(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
