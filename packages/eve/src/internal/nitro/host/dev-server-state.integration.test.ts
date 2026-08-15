import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DevelopmentServerState } from "#internal/nitro/host/dev-server-state.js";

const STATE_FILE_NAME = "dev-server-state.v1.json";
const temporaryRoots: string[] = [];

async function createState(): Promise<DevelopmentServerState> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-dev-server-state-"));
  temporaryRoots.push(appRoot);
  return new DevelopmentServerState({ appRoot });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("DevelopmentServerState", () => {
  it("returns no URL when no state file exists", async () => {
    const state = await createState();

    await expect(state.read()).resolves.toBeUndefined();
  });

  it("writes and reads the ready server URL", async () => {
    const state = await createState();

    await state.write("http://127.0.0.1:2000/");

    await expect(state.read()).resolves.toBe("http://127.0.0.1:2000/");
    await expect(readFile(join(state.appRoot, ".eve", STATE_FILE_NAME), "utf8")).resolves.toBe(
      '{"url":"http://127.0.0.1:2000/"}\n',
    );
  });

  it("treats malformed state as stale", async () => {
    const state = await createState();
    await mkdir(join(state.appRoot, ".eve"), { recursive: true });
    await writeFile(join(state.appRoot, ".eve", STATE_FILE_NAME), "{ not json", "utf8");

    await expect(state.read()).resolves.toBeUndefined();
  });

  it("removes the state record", async () => {
    const state = await createState();
    await state.write("http://127.0.0.1:2000/");

    await state.remove();

    await expect(state.read()).resolves.toBeUndefined();
  });
});
