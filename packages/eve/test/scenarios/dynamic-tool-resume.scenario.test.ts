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
import { startEveDev, waitForCondition } from "#internal/testing/dev-server-harness.js";

const scenarioApp = useScenarioApp();

const DURABLE_FACTORY_SOURCE = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool as tool } from "eve/tools";
import { z } from "zod";

interface MarkerService {
  readonly createdInPid: number;
  readonly key: string;
}

const services = new Map<string, MarkerService>();

function writeMarker(phase: string, key: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(process.cwd(), ".dynamic-" + phase + "-" + key + ".json"),
    JSON.stringify({ ...extra, key, phase, pid: process.pid }),
  );
}

export function createDurableMarkerTool(key: string) {
  const suffix = process.env.EVE_SCHEMA_TEST_SUFFIX ?? "";
  services.set(key, { createdInPid: process.pid, key });

  return tool({
    description: "Durable marker tool " + key + ".",
    inputSchema: z.object({ label: z.string().transform((value) => value.toUpperCase() + suffix).optional() }),
    approval: {
      request(context) {
        writeMarker("approval-request", key, { callId: context.callId });
        return "user-approval";
      },
      response(context) {
        writeMarker("approval-response", key, { decision: context.response.decision });
        return { status: "allowed" };
      },
    },
    execute(input) {
      const service = services.get(key);
      if (service === undefined) throw new Error("Missing live marker service for " + key + ".");
      const output = {
        key,
        label: input.label ?? "unlabeled",
        suffix,
        pid: process.pid,
        rawSecret: "raw-secret-" + key,
        serviceCreatedInPid: service.createdInPid,
      };
      writeMarker("execute", key, output);
      return output;
    },
    toModelOutput(output) {
      writeMarker("projection", key, {
        outputPid: output.pid,
        serviceCreatedInPid: output.serviceCreatedInPid,
      });
      return { type: "text", value: "projected-" + key };
    },
  });
}
`;

const DYNAMIC_TOOLS_SOURCE = `import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { defineDynamic } from "eve/tools";
import { createDurableMarkerTool } from "../lib/durable-factory.ts";

const guardedMarker = createDurableMarkerTool("guarded");
const companionMarker = createDurableMarkerTool("companion");

export default defineDynamic(() => {
  appendFileSync(join(process.cwd(), ".dynamic-resolver-runs"), process.pid + "\\n");
  return {
    guarded_marker: guardedMarker,
    companion_marker: companionMarker,
  };
});
`;

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

export default defineDynamic(() => ({
  alpha_marker: createEditableMarkerTool("alpha", "v1"),
  beta_marker: createEditableMarkerTool("beta", "v1"),
}));
`;

const DYNAMIC_TOOL_RESUME_DESCRIPTOR: ScenarioAppDescriptor = {
  ...TRANSACTIONAL_REBUILD_DESCRIPTOR,
  name: "dynamic-tool-resume",
  files: {
    ...Object.fromEntries(
      Object.entries(TRANSACTIONAL_REBUILD_DESCRIPTOR.files).filter(
        ([path]) => path !== "agent/tools/get_weather.ts" && !path.startsWith("agent/skills/"),
      ),
    ),
    "agent/lib/durable-factory.ts": DURABLE_FACTORY_SOURCE,
    "agent/tools/durable-dynamic.ts": DYNAMIC_TOOLS_SOURCE,
    "agent/lib/editable-factory.ts": editableFactorySource(1),
    "agent/tools/editable-dynamic.ts": EDITABLE_TOOLS_SOURCE,
  },
};

interface Marker {
  readonly key: string;
  readonly phase: string;
  readonly pid: number;
  readonly serviceCreatedInPid?: number;
  readonly label?: string;
  readonly suffix?: string;
}

async function readMarker(appRoot: string, phase: string, key: string): Promise<Marker> {
  return JSON.parse(
    await readFile(join(appRoot, `.dynamic-${phase}-${key}.json`), "utf8"),
  ) as Marker;
}

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

// One crash and `--resume` of `eve dev` with approvals parked on dynamic tools, in two sessions.
// The fresh process renders the approved calls' tools again and runs every callback phase there
// (cold replay), and a module edited while they were parked still runs the generation that
// created each approval, under its own tool identity (source edit).
describe("dynamic tools across an eve dev crash and resume", () => {
  it(
    "renders parked approvals' tools again in the fresh process, on the generation that created them",
    async () => {
      const app = await scenarioApp(DYNAMIC_TOOL_RESUME_DESCRIPTOR);
      const pinnedEnv = {
        WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS: "1",
      };
      let server = await startEveDev(app.appRoot, {
        env: { ...pinnedEnv, EVE_SCHEMA_TEST_SUFFIX: ":original" },
      });

      try {
        const client = new Client({ baseUrl: server.url });
        /** Opens a session and parks it on two approvals. */
        const park = async (message: string) => {
          const created = await client.sessions.create({ message: "Hello." });
          await expect(created.delivery.result()).resolves.toMatchObject({
            interactions: [],
            status: "completed",
          });
          const delivery = await created.session.send(message);
          const events = [];
          for await (const event of delivery.stream()) events.push(event);
          const waiting = await delivery.result();
          expect(waiting.status).toBe("awaiting-input");
          expect(
            waiting.interactions,
            `Expected two approval requests.\n\nevents:\n${JSON.stringify(events, null, 2)}\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`,
          ).toHaveLength(2);
          return { state: created.session.state, waiting };
        };
        const durable = await park("Call tools in parallel: guarded_marker, companion_marker");
        const editable = await park("Call tools in parallel: alpha_marker, beta_marker");

        const firstRequest = await readMarker(app.appRoot, "approval-request", "guarded");
        const resolverRunsBeforeRestart = (
          await readFile(join(app.appRoot, ".dynamic-resolver-runs"), "utf8")
        )
          .trim()
          .split("\n");
        expect(resolverRunsBeforeRestart.length).toBeGreaterThan(0);

        // Edit the callback module while approvals are parked: pad the top of
        // the file (shifting every byte offset below — the old identity scheme
        // resolved parked calls by those offsets) and bump the built-in
        // constant so the edited body is observable.
        await writeFile(
          join(app.appRoot, "agent", "lib", "editable-factory.ts"),
          "// padding line\n// another padding line\n\n" + editableFactorySource(2),
        );

        await server.crash();
        await waitForCondition(async () => {
          try {
            await readFile(join(app.appRoot, ".eve", "dev-server-state.v1.json"));
            return false;
          } catch (error) {
            return error instanceof Error && "code" in error && error.code === "ENOENT";
          }
        }, "The crashed development server did not release its state record.");
        server = await startEveDev(app.appRoot, {
          resume: true,
          env: { ...pinnedEnv, EVE_SCHEMA_TEST_SUFFIX: ":changed" },
        });

        const approve = async ({ state, waiting }: Awaited<ReturnType<typeof park>>) => {
          const resumedSession = new Client({ baseUrl: server.url }).sessions.attach(
            state.sessionId,
            { streamIndex: state.streamIndex },
          );
          const resumed = await (
            await resumedSession.respond(
              waiting.interactions.map((request) => ({
                optionId: "approve",
                interactionId: request.interactionId,
              })),
            )
          ).result();
          expect(resumed.status).toBe("completed");
        };
        await approve(durable);
        await approve(editable);

        for (const key of ["guarded", "companion"]) {
          const response = await readMarker(app.appRoot, "approval-response", key);
          const execute = await readMarker(app.appRoot, "execute", key);
          const projection = await readMarker(app.appRoot, "projection", key);

          expect(response.pid).not.toBe(firstRequest.pid);
          expect(execute.pid).toBe(response.pid);
          expect(execute.serviceCreatedInPid).toBe(execute.pid);
          // The call's input was validated when the model made it; the code that runs it is the
          // fresh process's own, rendered there.
          expect(execute.label).toBe("STRUCTURED-OUTPUT:original");
          expect(execute.suffix).toBe(":changed");
          expect(projection.pid).toBe(execute.pid);
        }

        // The fresh process has no live tools, so it renders them again from what the session
        // recorded: callbacks are code, never snapshotted.
        const resolverRunsAfterRestart = (
          await readFile(join(app.appRoot, ".dynamic-resolver-runs"), "utf8")
        )
          .trim()
          .split("\n");
        expect(resolverRunsAfterRestart.slice(0, resolverRunsBeforeRestart.length)).toEqual(
          resolverRunsBeforeRestart,
        );
        const rendersAfterRestart = resolverRunsAfterRestart.slice(
          resolverRunsBeforeRestart.length,
        );
        expect(rendersAfterRestart.length).toBeGreaterThan(0);
        expect(rendersAfterRestart.every((pid) => pid !== String(firstRequest.pid))).toBe(true);

        // Pending approvals make the session ineligible for deployment
        // handoff. Each parked call must run its own tool — never the other
        // one — using the generation that created the approval.
        const alpha = await readExecuteMarker(app.appRoot, "alpha");
        const beta = await readExecuteMarker(app.appRoot, "beta");
        expect(alpha).toMatchObject({ build: 1, key: "alpha", version: "v1" });
        expect(beta).toMatchObject({ build: 1, key: "beta", version: "v1" });
        expect(alpha.pid).toBe(beta.pid);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
