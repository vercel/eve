import { afterEach, describe, expect, it } from "vitest";

import { createTestBoard, type TestBoard } from "#internal/testing/board-server.js";
import { createBoardClient, type BoardClient } from "#public/channels/board/client.js";
import {
  reconcileRegistration,
  type BoardWatcherConfig,
} from "#public/channels/board/registration.js";

const watcher = (tail: string): BoardWatcherConfig => ({
  previews: false,
  watchers: { eve: { tail } },
});

const env = {};

const boards: TestBoard[] = [];

afterEach(() => {
  for (const board of boards.splice(0)) board.dispose();
});

describe("reconcileRegistration against @vercel/board", () => {
  it("bootstraps on a cold start, keeps a newer tail from older deployments, and lets a wake-up replace it", async () => {
    boards.push(await createTestBoard());
    const client = createBoardClient({ profile: "eve" });
    const registered = async () => (await client.watchers()).map((r) => r.watch);

    await expect(
      reconcileRegistration({ client, env, overwrite: false, watcher: watcher("dev") }),
    ).resolves.toBe("registered");
    expect(await registered()).toEqual([{ eve: { tail: "dev" } }]);

    await expect(
      reconcileRegistration({ client, env, overwrite: false, watcher: watcher("old") }),
    ).resolves.toBe("skipped");
    expect(await registered()).toEqual([{ eve: { tail: "dev" } }]);

    await expect(
      reconcileRegistration({ client, env, overwrite: true, watcher: watcher("ops") }),
    ).resolves.toBe("registered");
    await expect(
      reconcileRegistration({ client, env, overwrite: true, watcher: watcher("ops") }),
    ).resolves.toBe("unchanged");
    expect(await registered()).toEqual([{ eve: { tail: "ops" } }]);
  });

  it("says how to develop locally when Vercel's board refuses a person's registration", async () => {
    const refused = Object.assign(new Error("watchers need a project"), {
      code: "watchers_need_project",
    });
    const client = {
      discovery: async () => ({ url: "https://api.vercel.com", wake_by_path: true }),
      me: async () => ({ actor: "vercel:user:ada+eve", principal: "vercel:user:ada" }),
      register: async () => {
        throw refused;
      },
      watchers: async () => [],
    } as Partial<BoardClient> as BoardClient;

    await expect(
      reconcileRegistration({ client, env: {}, overwrite: true, watcher: watcher("dev") }),
    ).rejects.toThrow(/npx @vercel\/board serve.*BOARD_URL/u);
  });
});
