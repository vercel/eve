import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DevelopmentServerState } from "#internal/nitro/host/dev-server-state.js";

const STATE_FILE_NAME = "dev-server-state.v1.json";
const temporaryRoots: string[] = [];

const recordAt = (port: number) => ({
  url: `http://127.0.0.1:${port}/`,
  pid: 4242,
  id: "server-id",
});

async function createState(): Promise<DevelopmentServerState> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-dev-server-state-"));
  temporaryRoots.push(appRoot);
  return new DevelopmentServerState({ appRoot });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("DevelopmentServerState", () => {
  it("returns no record when no state file exists", async () => {
    const state = await createState();

    await expect(state.read()).resolves.toBeUndefined();
  });

  it("writes and reads the server's URL, pid and id", async () => {
    const state = await createState();

    await state.write(recordAt(2000));

    await expect(state.read()).resolves.toEqual(recordAt(2000));
    await expect(readFile(join(state.appRoot, ".eve", STATE_FILE_NAME), "utf8")).resolves.toBe(
      '{"url":"http://127.0.0.1:2000/","pid":4242,"id":"server-id"}\n',
    );
  });

  it("treats a record without the server's pid and id as stale", async () => {
    const state = await createState();
    await mkdir(join(state.appRoot, ".eve"), { recursive: true });
    await writeFile(
      join(state.appRoot, ".eve", STATE_FILE_NAME),
      '{"url":"http://127.0.0.1:2000/"}\n',
      "utf8",
    );

    await expect(state.read()).resolves.toBeUndefined();
  });

  it("treats malformed state as stale", async () => {
    const state = await createState();
    await mkdir(join(state.appRoot, ".eve"), { recursive: true });
    await writeFile(join(state.appRoot, ".eve", STATE_FILE_NAME), "{ not json", "utf8");

    await expect(state.read()).resolves.toBeUndefined();
  });

  it("removes the state record", async () => {
    const state = await createState();
    await state.write(recordAt(2000));

    await state.remove();

    await expect(state.read()).resolves.toBeUndefined();
  });

  it("ignores the app's record when a separate state directory is configured", async () => {
    const state = await createState();
    await state.write(recordAt(2000));
    const stateDirectory = join(state.appRoot, ".eve", "eval-servers", "run-1");
    vi.stubEnv("EVE_DEV", "1");
    vi.stubEnv("EVE_DEV_STATE_DIR", stateDirectory);
    const isolated = new DevelopmentServerState({ appRoot: state.appRoot });

    await expect(isolated.read()).resolves.toBeUndefined();
    await isolated.write(recordAt(2001));

    await expect(readFile(join(stateDirectory, STATE_FILE_NAME), "utf8")).resolves.toBe(
      '{"url":"http://127.0.0.1:2001/","pid":4242,"id":"server-id"}\n',
    );
    await expect(state.read()).resolves.toEqual(recordAt(2000));
  });
});
