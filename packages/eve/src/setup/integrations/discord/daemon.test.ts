import { describe, expect, it } from "vitest";

import { withDiscordDaemon } from "./daemon.js";

const DAEMON = { entrypoint: "Dockerfile", instances: { iad1: 1 }, root: "daemon" };

describe("withDiscordDaemon", () => {
  it("creates vercel.json with the daemon when there is none", () => {
    expect(JSON.parse(withDiscordDaemon(undefined)!)).toEqual({
      $schema: "https://openapi.vercel.sh/vercel.json",
      daemons: { "discord-gateway": DAEMON },
    });
  });

  it("adds the daemon beside the project's own settings and daemons", () => {
    const existing = JSON.stringify({ daemons: { worker: { root: "worker" } }, regions: ["sfo1"] });

    expect(JSON.parse(withDiscordDaemon(existing)!)).toEqual({
      // The relay runs in the project's first function region.
      daemons: {
        "discord-gateway": { ...DAEMON, instances: { sfo1: 1 } },
        worker: { root: "worker" },
      },
      regions: ["sfo1"],
    });
  });

  it("leaves a vercel.json that already has the daemon untouched", () => {
    const existing = JSON.stringify({ daemons: { "discord-gateway": { root: "relay" } } });

    expect(withDiscordDaemon(existing)).toBeUndefined();
  });

  it("refuses a daemons value it would have to replace", () => {
    expect(() => withDiscordDaemon(JSON.stringify({ daemons: ["worker"] }))).toThrow(
      "`daemons` value that isn't an object",
    );
  });

  it("refuses a vercel.json it can't parse instead of overwriting it", () => {
    expect(() => withDiscordDaemon("{ nope")).toThrow("vercel.json contains invalid JSON");
  });
});
