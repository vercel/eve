import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import { compileAgent } from "../../src/compiler/compile-agent.js";
import { EVE_HEALTH_ROUTE_PATH } from "../../src/protocol/routes.js";
import {
  useScenarioApp,
  type ScenarioAppDescriptor,
} from "../../src/internal/testing/scenario-app.js";
import {
  DEV_SERVER_AGENT_DESCRIPTOR,
  DEV_SERVER_SCENARIO_TIMEOUT_MS,
} from "./dev-server-descriptors.js";
import {
  forceDevelopmentRebuild,
  readDevelopmentRevision,
  startEveDev,
} from "./dev-server-harness.js";

const HOME_LOGICAL_PATH = "channels/home.ts";
const HEALTH_LOGICAL_PATH = "channels/eve/v1/health.ts";

const AUTHORED_HOME_SOURCE = `import { defineChannel, GET } from "eve/channels";

export default defineChannel({
  routes: [GET("/", () => new Response("authored home"))],
});
`;

const AUTHORED_HEALTH_SOURCE = `import { defineChannel, GET, HEAD } from "eve/channels";

const respond = () => Response.json({
  ok: true,
  status: "ready",
  workflowId: "authored-health",
});

export default defineChannel({
  routes: [
    GET("${EVE_HEALTH_ROUTE_PATH}", respond),
    HEAD("${EVE_HEALTH_ROUTE_PATH}", respond),
  ],
});
`;

const DISABLED_HEALTH_SOURCE = `import { disableRoute } from "eve/channels";

export default disableRoute();
`;

const AUTHORED_SANDBOX_SOURCE = `import { defineSandbox } from "eve/sandbox";

export default defineSandbox({});
`;

const AUTHORED_FRAMEWORK_CHANNELS_DESCRIPTOR: ScenarioAppDescriptor = {
  ...DEV_SERVER_AGENT_DESCRIPTOR,
  files: {
    ...DEV_SERVER_AGENT_DESCRIPTOR.files,
    [`agent/${HOME_LOGICAL_PATH}`]: AUTHORED_HOME_SOURCE,
    [`agent/${HEALTH_LOGICAL_PATH}`]: AUTHORED_HEALTH_SOURCE,
    "agent/sandbox.ts": AUTHORED_SANDBOX_SOURCE,
  },
  name: "authored-framework-channels",
};

const scenarioApp = useScenarioApp();

describe("framework channel source composition", () => {
  it(
    "uses authored home and health through compilation, Nitro dispatch, and Client.health",
    async () => {
      const app = await scenarioApp(AUTHORED_FRAMEWORK_CHANNELS_DESCRIPTOR);
      const compiled = await compileAgent({ startPath: app.appRoot });

      const healthRoutes = compiled.manifest.channelRoutes.effective.filter(
        (route) => route.urlPath === EVE_HEALTH_ROUTE_PATH,
      );
      expect(healthRoutes.map((route) => route.method)).toEqual(["GET", "HEAD"]);
      expect(healthRoutes).toEqual(
        expect.arrayContaining([expect.objectContaining({ logicalPath: HEALTH_LOGICAL_PATH })]),
      );

      for (const route of healthRoutes) {
        expect(compiled.manifest.bindings[route.sourceId]).toMatchObject({
          logicalPath: HEALTH_LOGICAL_PATH,
          owner: { kind: "application" },
        });
      }
      expect(compiled.manifest.sourceComposition.shadowed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            slot: "channels/eve/v1/health",
            source: expect.objectContaining({
              logicalPath: HEALTH_LOGICAL_PATH,
              owner: { feature: "eve.framework-root", kind: "framework" },
            }),
          }),
          expect.objectContaining({
            slot: "channels/home",
            source: expect.objectContaining({
              logicalPath: HOME_LOGICAL_PATH,
              owner: { feature: "eve.framework-root", kind: "framework" },
            }),
          }),
        ]),
      );
      expect(compiled.manifest.sandbox).toMatchObject({
        logicalPath: "sandbox.ts",
        sourceId: "sandbox.ts",
      });
      expect(compiled.manifest.bindings["sandbox.ts"]).toMatchObject({
        logicalPath: "sandbox.ts",
        owner: { kind: "application" },
      });
      expect(compiled.manifest.bindings["eve.framework-defaults:sandbox.ts"]).toBeUndefined();
      expect(compiled.manifest.sourceComposition.shadowed).toContainEqual(
        expect.objectContaining({
          slot: "sandbox",
          source: expect.objectContaining({
            owner: { feature: "eve.framework-defaults", kind: "framework" },
            sourceId: "eve.framework-defaults:sandbox.ts",
          }),
          winningSourceId: "sandbox.ts",
        }),
      );

      const server = await startEveDev(app.appRoot);
      try {
        await expect(
          fetch(new URL("/", server.url)).then((response) => response.text()),
        ).resolves.toBe("authored home");
        const client = new Client({ host: server.url });
        await expect(client.health()).resolves.toEqual({
          ok: true,
          status: "ready",
          workflowId: "authored-health",
        });

        const revision = await readDevelopmentRevision(server.url);
        await writeFile(join(app.appRoot, "agent", HEALTH_LOGICAL_PATH), DISABLED_HEALTH_SOURCE);
        await forceDevelopmentRebuild(server.url);

        await expect(readDevelopmentRevision(server.url)).resolves.not.toBe(revision);
        await expect(client.health()).rejects.toMatchObject({ status: 404 });
        await expect(
          fetch(new URL("/", server.url)).then((response) => response.text()),
        ).resolves.toBe("authored home");
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
