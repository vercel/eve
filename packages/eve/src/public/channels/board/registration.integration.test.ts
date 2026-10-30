import { describe, expect, it } from "vitest";

import { createTestBoard } from "#internal/testing/board-server.js";
import { createBoardClient } from "#public/channels/board/client.js";
import {
  reconcileRegistration,
  type BoardWatcherConfig,
} from "#public/channels/board/registration.js";

const watcher = (tail: string): BoardWatcherConfig => ({
  previews: false,
  watchers: { eve: { tail, when: "matches" } },
});

// A production deployment on a board that wakes only URLs.
const env = { VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "agent.example.com" };

describe("reconcileRegistration against @vercel/board", () => {
  it("bootstraps on a cold start, keeps a newer tail from older deployments, and lets a wake-up replace it", async () => {
    const team = createTestBoard();
    const client = createBoardClient({
      api: { fetch: (input, init) => team.fetch(new Request(input, init)) },
      credentials: { token: () => team.eveToken() },
      profile: "eve",
      url: team.url,
    });
    const registered = async () => (await client.watchers()).map((r) => r.watch);

    // Nothing is registered, so a cold start registers.
    await expect(
      reconcileRegistration({ client, env, overwrite: false, watcher: watcher("dev") }),
    ).resolves.toBe("registered");
    expect(await registered()).toEqual([{ eve: { tail: "dev", when: "matches" } }]);

    // A deployment still finishing a run cold-starts with an older tail: it must not overwrite.
    await expect(
      reconcileRegistration({ client, env, overwrite: false, watcher: watcher("old") }),
    ).resolves.toBe("skipped");
    expect(await registered()).toEqual([{ eve: { tail: "dev", when: "matches" } }]);

    // A wake-up reaches the current wake target, which replaces a registration that differs.
    await expect(
      reconcileRegistration({ client, env, overwrite: true, watcher: watcher("ops") }),
    ).resolves.toBe("registered");
    await expect(
      reconcileRegistration({ client, env, overwrite: true, watcher: watcher("ops") }),
    ).resolves.toBe("unchanged");
    expect(await registered()).toEqual([{ eve: { tail: "ops", when: "matches" } }]);
  });

  it("surfaces the board's access error, which names the rule to add", async () => {
    const team = createTestBoard();
    const client = createBoardClient({
      api: { fetch: (input, init) => team.fetch(new Request(input, init)) },
      credentials: { token: () => team.eveToken("preview") },
      profile: "eve",
      url: team.url,
    });
    await expect(
      reconcileRegistration({ client, env, overwrite: false, watcher: watcher("dev") }),
    ).rejects.toThrow(/403 forbidden: .*vercelProject\(\{ project: 'eve', can \}\)/u);
  });
});
