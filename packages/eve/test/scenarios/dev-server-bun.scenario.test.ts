import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WEATHER_AGENT_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/weather-agent.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { sendDevelopmentMessage } from "../dev-client-harness/send-message.js";
import { createDevelopmentSessionState } from "../dev-client-harness/session.js";
import {
  hasKnownDevServerFailure,
  isBunAvailable,
  runEveDevToExit,
  startEveDev,
} from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

const BUN_DEV_SERVER_TIMEOUT_MS = 360_000;
const BUN_LAYOUT_DESCRIPTOR: ScenarioAppDescriptor = {
  ...WEATHER_AGENT_DESCRIPTOR,
  name: "weather-agent-bun",
  packageManager: "bun",
};

const bunAvailable = isBunAvailable();

// Stands in for `bun --bun next dev`: Next.js loads `withEve` and asks for
// rewrites in the development phase, which spawns the eve dev sidecar.
const WITH_EVE_DEV_PROBE = `import { withEve } from "eve/next";

const config = await withEve({})("phase-development-server", { defaultConfig: {} });
const rewrites = await config.rewrites();
console.log("eve-rewrites:" + JSON.stringify(rewrites));
process.exit(0);
`;

describe("eve dev server with bun", () => {
  it("keeps bun available in CI so the suite cannot silently skip", () => {
    if (process.env.CI !== undefined) {
      expect(bunAvailable).toBe(true);
    }
  });

  it.skipIf(!bunAvailable)(
    "serves a bun-installed app under the Node runtime",
    async () => {
      const app = await scenarioApp(BUN_LAYOUT_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const messageResult = await sendDevelopmentMessage({
          message: "What's the weather in Lisbon?",
          session: createDevelopmentSessionState(),
          serverUrl: server.url,
        });
        expect(
          messageResult.events.some((event) => event.type === "message.completed"),
          [
            "Expected the bun-installed dev server to complete a streamed turn.",
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(true);
        expect(hasKnownDevServerFailure(`${server.stdout()}\n${server.stderr()}`)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    BUN_DEV_SERVER_TIMEOUT_MS,
  );

  // Bun cannot run the dev server today: Nitro wires crossws's Node adapter
  // into every dev worker, and that adapter refuses to initialize when the
  // Bun global exists. Until that support lands upstream, the contract is a
  // fast, explanatory startup failure instead of a hang or a half-broken
  // server. Replace this with a boot-and-stream assertion when `bun eve dev`
  // becomes supported.
  it.skipIf(!bunAvailable)(
    "fails fast with the worker readiness error when the CLI runs under bun",
    async () => {
      const app = await scenarioApp(BUN_LAYOUT_DESCRIPTOR);

      const result = await runEveDevToExit(app.appRoot, {
        defaultExtensions: false,
        runtime: "bun",
      });

      expect(result.code).not.toBe(0);
      expect(result.output).toContain("failed before readiness");
    },
    BUN_DEV_SERVER_TIMEOUT_MS,
  );

  it.skipIf(!bunAvailable)(
    "starts the withEve dev server under Node when the framework runs under bun --bun",
    async () => {
      const app = await scenarioApp({
        ...BUN_LAYOUT_DESCRIPTOR,
        files: { ...BUN_LAYOUT_DESCRIPTOR.files, "with-eve-probe.mjs": WITH_EVE_DEV_PROBE },
      });
      const packageJsonPath = join(app.appRoot, "package.json");
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<
        string,
        unknown
      >;
      // A package script, unlike `bun --bun <file>`, gets Bun's `node` PATH shim.
      packageJson.scripts = { probe: "node with-eve-probe.mjs" };
      await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

      const result = spawnSync("bun", ["--bun", "run", "probe"], {
        cwd: app.appRoot,
        encoding: "utf8",
        env: { ...process.env, EVE_BASE_URL: "", NODE_ENV: "development" },
        timeout: 180_000,
      });
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status, output).toBe(0);
      expect(output).toMatch(/eve-rewrites:.*http:\/\/127\.0\.0\.1:\d+/);
    },
    BUN_DEV_SERVER_TIMEOUT_MS,
  );
});
