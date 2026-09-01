import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Client } from "../../src/client/index.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import {
  DEV_SERVER_SCENARIO_TIMEOUT_MS,
  TRANSACTIONAL_REBUILD_DESCRIPTOR,
} from "./dev-server-descriptors.js";
import { startEveDev, waitForCondition } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

function editableFactorySource(build: number): string {
  return `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool as tool } from "eve/tools";
import { z } from "zod";

const BUILD = ${build};

export function createEditableMarkerTool(key: string, version: string) {
  return tool({
    description: "Editable marker tool " + key + ".",
    inputSchema: z.object({}),
    approval: {
      request() {
        return "user-approval";
      },
      response() {
        return { status: "allowed" };
      },
    },
    execute() {
      const output = { build: BUILD, key, pid: process.pid, version };
      writeFileSync(
        join(process.cwd(), ".editable-execute-" + key + ".json"),
        JSON.stringify(output),
      );
      return output;
    },
  });
}
`;
}

const EDITABLE_TOOLS_SOURCE = `import { defineDynamic } from "eve/tools";
import { createEditableMarkerTool } from "../lib/editable-factory.ts";

export default defineDynamic({
  events: {
    "session.started": () => ({
      alpha_marker: createEditableMarkerTool("alpha", "v1"),
      beta_marker: createEditableMarkerTool("beta", "v1"),
    }),
  },
});
`;

const EDITABLE_DYNAMIC_DESCRIPTOR: ScenarioAppDescriptor = {
  ...TRANSACTIONAL_REBUILD_DESCRIPTOR,
  name: "dynamic-tool-source-edit",
  files: {
    ...Object.fromEntries(
      Object.entries(TRANSACTIONAL_REBUILD_DESCRIPTOR.files).filter(
        ([path]) => path !== "agent/tools/get_weather.ts" && !path.startsWith("agent/skills/"),
      ),
    ),
    "agent/lib/editable-factory.ts": editableFactorySource(1),
    "agent/tools/editable-dynamic.ts": EDITABLE_TOOLS_SOURCE,
  },
};

interface ExecuteMarker {
  readonly build: number;
  readonly key: string;
  readonly pid: number;
  readonly version: string;
}

async function readExecuteMarker(appRoot: string, key: string): Promise<ExecuteMarker> {
  return JSON.parse(
    await readFile(join(appRoot, `.editable-execute-${key}.json`), "utf8"),
  ) as ExecuteMarker;
}

describe("dynamic tool source edits across a restart", () => {
  it(
    "replays parked approvals against the latest code under the same tool identity",
    async () => {
      const app = await scenarioApp(EDITABLE_DYNAMIC_DESCRIPTOR);
      const pinnedEnv = {
        VERCEL_DEPLOYMENT_ID: "dynamic-tool-source-edit",
        WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS: "1",
      };
      let server = await startEveDev(app.appRoot, { env: pinnedEnv });

      try {
        const client = new Client({ host: server.url });
        const created = await client.sessions.create({ message: "Hello." });
        await expect(created.response.result()).resolves.toMatchObject({
          inputRequests: [],
          status: "waiting",
        });

        const waiting = await (
          await created.session.send("Call tools in parallel: alpha_marker, beta_marker")
        ).result();
        expect(waiting.status).toBe("waiting");
        expect(waiting.inputRequests).toHaveLength(2);

        // Edit the callback module while approvals are parked: pad the top of
        // the file (shifting every byte offset below — the old identity scheme
        // resolved parked calls by those offsets) and bump the built-in
        // constant so the edited body is observable.
        await writeFile(
          join(app.appRoot, "agent", "lib", "editable-factory.ts"),
          "// padding line\n// another padding line\n\n" + editableFactorySource(2),
        );

        const sessionState = created.session.state;

        await server.crash();
        await waitForCondition(async () => {
          try {
            await readFile(join(app.appRoot, ".eve", "dev-server-state.v1.json"));
            return false;
          } catch (error) {
            return error instanceof Error && "code" in error && error.code === "ENOENT";
          }
        }, "The crashed development server did not release its state record.");
        server = await startEveDev(app.appRoot, { env: pinnedEnv });

        const resumedSession = new Client({ host: server.url }).sessions.attach(
          sessionState.sessionId,
          { streamIndex: sessionState.streamIndex },
        );
        const resumed = await (
          await resumedSession.respond(
            waiting.inputRequests.map((request) => ({
              optionId: "approve",
              requestId: request.requestId,
            })),
          )
        ).result();
        expect(resumed.status).toBe("waiting");

        // Each parked call must run its own tool — never the other one — and
        // both must run the edited body from the latest code.
        const alpha = await readExecuteMarker(app.appRoot, "alpha");
        const beta = await readExecuteMarker(app.appRoot, "beta");
        expect(alpha).toMatchObject({ build: 2, key: "alpha", version: "v1" });
        expect(beta).toMatchObject({ build: 2, key: "beta", version: "v1" });
        expect(alpha.pid).toBe(beta.pid);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
