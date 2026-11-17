import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "#compiled/zod/index.js";
import { resolveDevelopmentStateDirectory } from "#internal/application/dev-environment.js";
import { httpServerUrlSchema } from "#shared/network-address.js";

const STATE_FILE_NAME = "dev-server-state.v1.json";

const developmentServerStateSchema = z
  .object({
    url: httpServerUrlSchema,
  })
  .strict();

export class DevelopmentServerState {
  readonly appRoot: string;
  readonly #stateDir: string;
  readonly #statePath: string;

  constructor(project: { readonly appRoot: string }) {
    this.appRoot = project.appRoot;
    this.#stateDir = resolveDevelopmentStateDirectory(this.appRoot);
    this.#statePath = join(this.#stateDir, STATE_FILE_NAME);
  }

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

  async write(url: string): Promise<void> {
    const state = developmentServerStateSchema.parse({ url });
    await mkdir(this.#stateDir, { recursive: true });
    await writeFile(this.#statePath, `${JSON.stringify(state)}\n`, "utf8");
  }

  async remove(): Promise<void> {
    await rm(this.#statePath, { force: true });
  }
}

function isErrnoException(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
