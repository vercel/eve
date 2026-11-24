import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WEATHER_AGENT_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/weather-agent.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "#internal/testing/dev-server-harness.js";
import { EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH } from "#protocol/routes.js";

const scenarioApp = useScenarioApp();
const running: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(running.splice(0).map((server) => server.stop()));
});

async function start(appRoot: string, options?: { port: number }) {
  const server = await startEveDev(appRoot, options);
  running.push(server);
  return server;
}

interface StateRecord {
  readonly id: string;
  readonly pid: number;
  readonly url: string;
}

async function readRecord(appRoot: string): Promise<StateRecord> {
  return JSON.parse(
    await readFile(join(appRoot, ".eve", "dev-server-state.v1.json"), "utf8"),
  ) as StateRecord;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string") throw new Error("No port was assigned.");
  return address.port;
}

describe("eve dev state record", () => {
  it("starts when a crashed run's record names a port another app's eve server now holds", async () => {
    const crashed = await scenarioApp(WEATHER_AGENT_DESCRIPTOR);
    const other = await scenarioApp(WEATHER_AGENT_DESCRIPTOR);
    const port = await freePort();

    const first = await start(crashed.appRoot, { port });
    const stale = await readRecord(crashed.appRoot);
    process.kill(stale.pid, "SIGKILL");
    await first.stop();
    expect((await readRecord(crashed.appRoot)).url).toBe(stale.url);

    const holder = await start(other.appRoot, { port });
    expect(holder.url).toBe(stale.url);

    const restarted = await start(crashed.appRoot);

    expect(restarted.url).not.toBe(holder.url);
    const record = await readRecord(crashed.appRoot);
    expect(record.url).toBe(restarted.url);
    expect(record.id).not.toBe(stale.id);
    const answer = (await (
      await fetch(new URL(EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH, restarted.url))
    ).json()) as { serverId: string };
    expect(answer.serverId).toBe(record.id);
  }, 240_000);

  it("refuses a second server for an app whose own server is running", async () => {
    const app = await scenarioApp(WEATHER_AGENT_DESCRIPTOR);
    const first = await start(app.appRoot);

    await expect(start(app.appRoot)).rejects.toThrow("A dev server is already running");

    expect((await fetch(first.url)).status).toBeLessThan(500);
  }, 240_000);
});
