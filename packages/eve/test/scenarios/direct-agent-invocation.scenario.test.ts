import { describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { startEveDev, waitForCondition } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 360_000;

const DESCRIPTOR: ScenarioAppDescriptor = {
  dependencies: {
    "@eve/catalog": "file:./catalog",
    zod: "4.4.3",
  },
  files: {
    "catalog/package.json": JSON.stringify({
      name: "@eve/catalog",
      version: "0.0.0",
      type: "module",
      exports: "./index.js",
    }),
    "catalog/index.js": `export const channelEntries = () => [
  { slug: "eve", surfaces: { scaffoldable: true } },
  { slug: "slack", surfaces: { scaffoldable: true } },
];
export const connectionEntries = () => [];
export const connectionProtocols = (connection) => [
  connection.mcp ? "mcp" : null,
  connection.openapi ? "openapi" : null,
].filter(Boolean);
`,
    "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel((request) => {
    const history = request.messages.map((message) => message.text).join("\\n");
    if (request.lastUserMessage?.includes("root first")) return "ROOT_FIRST";
    if (request.lastUserMessage?.includes("root third")) {
      return history.includes("RESEARCHER_SAW_ROOT") ? "ROOT_SAW_RESEARCHER" : "ROOT_LOST_RESEARCHER";
    }
    if (request.lastUserMessage?.includes("root after hitl")) {
      return history.includes("RESEARCHER_HITL_RESUMED") ? "ROOT_AFTER_HITL" : "ROOT_LOST_HITL";
    }
    return "ROOT_UNEXPECTED";
  }),
  modelContextWindowTokens: 32_000,
});
`,
    "agent/instructions.md": "Run as the root test agent.\n",
    "agent/channels/eve.ts": `import { none } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: none(),
  onMessage(ctx) {
    return {
      auth: ctx.eve.caller,
      context: [\`HTTP_AGENT=\${ctx.eve.agent ?? "root"}\`],
    };
  },
});
`,
    "agent/channels/slash.ts": `import { defineChannel, GET, POST } from "eve/channels";

const completed = [];

export default defineChannel({
  routes: [
    POST("/slash", async (request, { from }) => {
      const body = await request.json();
      const session = await from(body.threadId).send(body.message, {
        agent: body.agent,
        auth: null,
      });
      return Response.json({ sessionId: session.id }, { status: 202 });
    }),
    GET("/slash/events", async () => Response.json(completed)),
  ],
  events: {
    "message.completed"(event, _channel, ctx) {
      completed.push({ message: event.message, sessionId: ctx.session.id });
    },
  },
});
`,
    "agent/channels/queue.ts": `import { defineChannel, GET, POST } from "eve/channels";

const events: Array<{ message?: string; sessionId: string; type: string }> = [];

export default defineChannel({
  turnPolicy: "queue",
  routes: [
    POST("/queue", async (request, { from }) => {
      const body = await request.json();
      const session = await from(body.threadId).send(body.message, {
        agent: body.agent,
        auth: null,
      });
      return Response.json({ sessionId: session.id }, { status: 202 });
    }),
    GET("/queue/events", async () => Response.json(events)),
  ],
  events: {
    "turn.started"(_event, _channel, ctx) {
      events.push({ sessionId: ctx.session.id, type: "turn.started" });
    },
    "message.completed"(event, _channel, ctx) {
      events.push({ message: event.message, sessionId: ctx.session.id, type: "message.completed" });
    },
  },
});
`,
    "agent/channels/steer.ts": `import { defineChannel, GET, POST } from "eve/channels";

const events: Array<{ message?: string; sessionId: string; type: string }> = [];

export default defineChannel({
  turnPolicy: "steer",
  routes: [
    POST("/steer", async (request, { from }) => {
      const body = await request.json();
      const session = await from(body.threadId).send(body.message, {
        agent: body.agent,
        auth: null,
      });
      return Response.json({ sessionId: session.id }, { status: 202 });
    }),
    GET("/steer/events", async () => Response.json(events)),
  ],
  events: {
    "turn.started"(_event, _channel, ctx) {
      events.push({ sessionId: ctx.session.id, type: "turn.started" });
    },
    "turn.cancelled"(_event, _channel, ctx) {
      events.push({ sessionId: ctx.session.id, type: "turn.cancelled" });
    },
    "message.completed"(event, _channel, ctx) {
      events.push({ message: event.message, sessionId: ctx.session.id, type: "message.completed" });
    },
  },
});
`,
    "agent/subagents/researcher/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Research direct-invocation requests.",
  model: mockModel(async (request) => {
    const history = request.messages.map((message) => message.text).join("\\n");
    const last = request.lastUserMessage ?? "";
    if (last.includes("research second")) {
      return history.includes("ROOT_FIRST") && history.includes("HTTP_AGENT=researcher")
        ? "RESEARCHER_SAW_ROOT"
        : "RESEARCHER_LOST_ROOT";
    }
    if (last.includes("direct create")) {
      return history.includes("HTTP_AGENT=researcher") ? "RESEARCHER_DEFAULT" : "RESEARCHER_NO_SELECTOR";
    }
    if (last.includes("follow default")) {
      return history.includes("RESEARCHER_DEFAULT") ? "RESEARCHER_DEFAULT_FOLLOW" : "RESEARCHER_LOST_DEFAULT";
    }
    if (last.includes("surface check")) {
      const result = request.toolResults.find((entry) => entry.name === "inspect_surface");
      if (result === undefined) {
        const hasInstructions = request.messages.some((message) =>
          message.role === "system" && message.text.includes("RESEARCHER_INSTRUCTIONS_TOKEN"),
        );
        const hasTool = request.tools.some((tool) => tool.name === "inspect_surface");
        return hasInstructions && hasTool
          ? { toolCalls: [{ id: "surface-check", input: {}, name: "inspect_surface" }] }
          : "RESEARCHER_SURFACE_MISSING";
      }
      const output = JSON.stringify(result.output);
      return output.includes('"sandboxOwner":"researcher"') && /"hookTurns":[1-9]/.test(output)
        ? "RESEARCHER_SURFACE_OK"
        : "RESEARCHER_SURFACE_BAD:" + output;
    }
    if (last.includes("hitl target")) {
      const answered = request.toolResults.some((entry) => entry.name === "ask_question");
      return answered
        ? "RESEARCHER_HITL_RESUMED"
        : {
            toolCalls: [{
              id: "researcher-question",
              input: {
                options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
                prompt: "Resume the researcher turn?",
              },
              name: "ask_question",
            }],
          };
    }
    if (last.includes("queue first")) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      return "QUEUE_RESEARCHER";
    }
    if (last.includes("steer first")) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return "STEER_RESEARCHER_SHOULD_CANCEL";
    }
    if (last.includes("steer default")) return "STEER_RESEARCHER_DEFAULT";
    if (last.includes("slash research")) return "CHANNEL_RESEARCHER";
    return "RESEARCHER_UNEXPECTED";
  }),
  modelContextWindowTokens: 32_000,
});
`,
    "agent/subagents/researcher/instructions.md":
      "Run as the researcher test agent. RESEARCHER_INSTRUCTIONS_TOKEN\n",
    "agent/subagents/researcher/lib/surface-state.ts": `import { defineState } from "eve/context";

export const surfaceState = defineState("researcher.surface", () => ({ turns: 0 }));
`,
    "agent/subagents/researcher/hooks/surface.ts": `import { defineHook } from "eve/hooks";
import { surfaceState } from "../lib/surface-state";

export default defineHook({
  events: {
    "turn.started"() {
      surfaceState.update((state) => ({ turns: state.turns + 1 }));
    },
  },
});
`,
    "agent/subagents/researcher/tools/inspect_surface.ts": `import { defineTool } from "eve/tools";
import { z } from "zod";
import { surfaceState } from "../lib/surface-state";

export default defineTool({
  description: "Inspect the researcher hook and sandbox.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    const sandboxOwner = await sandbox.readTextFile({ path: "owner.txt" });
    return { hookTurns: surfaceState.get().turns, sandboxOwner: sandboxOwner?.trim() };
  },
});
`,
    "agent/subagents/researcher/sandbox/sandbox.ts": `import { defineSandbox } from "eve/sandbox";

export default defineSandbox({});
`,
    "agent/subagents/researcher/sandbox/workspace/owner.txt": "researcher\n",
    "agent/subagents/researcher/subagents/critic/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Critique direct-invocation requests.",
  model: mockModel((request) => {
    if (request.lastUserMessage?.includes("queue critic")) return "QUEUE_CRITIC";
    if (request.lastUserMessage?.includes("steer critic")) return "STEER_CRITIC";
    return "CRITIC_DIRECT";
  }),
  modelContextWindowTokens: 32_000,
});
`,
    "agent/subagents/researcher/subagents/critic/instructions.md":
      "Run as the nested critic test agent.\n",
    "agent/subagents/conditional/agent.ts": `import { defineAgent, defineDynamic } from "eve";

export default defineDynamic({
  events: {
    "session.started": () => defineAgent({
      description: "A dynamic conditional agent.",
      model: "openai/gpt-5.4-mini",
    }),
  },
});
`,
    "agent/subagents/conditional/instructions.md": "Run conditionally.\n",
    "agent/subagents/remote.ts": `import { defineRemoteAgent } from "eve";

export default defineRemoteAgent({
  description: "An unreachable remote test agent.",
  url: "https://remote.invalid",
});
`,
  },
  installDependencies: true,
  name: "direct-agent-invocation",
};

describe("direct agent invocation", () => {
  it(
    "shares history for one-turn overrides, persists targeted defaults, and preserves channel flow",
    async () => {
      const app = await scenarioApp(DESCRIPTOR);
      const server = await startEveDev(app.appRoot, {
        env: { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
      });

      try {
        const client = new Client({ host: server.url });
        const root = await client.sessions.create({ message: "root first" });
        const first = await root.response.result();
        const researcher = await root.session
          .send("research second", { agent: "researcher" })
          .then((response) => response.result());
        const backToRoot = await root.session
          .send("root third")
          .then((response) => response.result());

        expect(first.message).toBe("ROOT_FIRST");
        expect(researcher.message, JSON.stringify(researcher.events, null, 2)).toBe(
          "RESEARCHER_SAW_ROOT",
        );
        expect(backToRoot.message).toBe("ROOT_SAW_RESEARCHER");
        expect([first.sessionId, researcher.sessionId, backToRoot.sessionId]).toEqual([
          root.session.state.sessionId,
          root.session.state.sessionId,
          root.session.state.sessionId,
        ]);
        expect(researcher.events.some((event) => event.type.startsWith("subagent."))).toBe(false);

        const surface = await root.session
          .send("surface check", { agent: "researcher" })
          .then((response) => response.result());
        expect(surface.message).toBe("RESEARCHER_SURFACE_OK");

        const hitlPending = await root.session
          .send("hitl target", { agent: "researcher" })
          .then((response) => response.result());
        expect(hitlPending.status).toBe("waiting");
        const inputRequested = hitlPending.events.find((event) => event.type === "input.requested");
        if (inputRequested?.type !== "input.requested") {
          throw new Error("Expected the targeted researcher turn to request input.");
        }
        const requestId = inputRequested.data.requests[0]?.requestId;
        if (requestId === undefined) throw new Error("Expected a researcher input request id.");
        const resumed = await root.session
          .respond([{ optionId: "yes", requestId }])
          .then((response) => response.result());
        expect(resumed.message).toBe("RESEARCHER_HITL_RESUMED");
        expect((await (await root.session.send("root after hitl")).result()).message).toBe(
          "ROOT_AFTER_HITL",
        );

        const direct = await client.sessions.create({
          agent: "researcher",
          message: "direct create",
        });
        expect((await direct.response.result()).message).toBe("RESEARCHER_DEFAULT");
        expect((await (await direct.session.send("follow default")).result()).message).toBe(
          "RESEARCHER_DEFAULT_FOLLOW",
        );

        const nested = await client.sessions.create({
          agent: "researcher/critic",
          message: "nested direct",
        });
        expect((await nested.response.result()).message).toBe("CRITIC_DIRECT");

        const slashResponse = await fetch(new URL("/slash", server.url), {
          body: JSON.stringify({
            agent: "researcher",
            message: "slash research",
            threadId: "thread-1",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        expect(slashResponse.status).toBe(202);
        const slashSessionId = ((await slashResponse.json()) as { sessionId: string }).sessionId;
        let slashEvents: Array<{ message: string; sessionId: string }> = [];
        await waitForCondition(async () => {
          slashEvents = (await fetch(new URL("/slash/events", server.url)).then((response) =>
            response.json(),
          )) as Array<{ message: string; sessionId: string }>;
          return slashEvents.some((event) => event.message === "CHANNEL_RESEARCHER");
        }, "Timed out waiting for the targeted channel event.");
        expect(slashEvents).toContainEqual({
          message: "CHANNEL_RESEARCHER",
          sessionId: slashSessionId,
        });

        const queuedResearcher = await sendRoutedChannel(server.url, "/queue", {
          agent: "researcher",
          message: "queue first",
          threadId: "queue-thread",
        });
        const queuedCritic = await sendRoutedChannel(server.url, "/queue", {
          agent: "researcher/critic",
          message: "queue critic",
          threadId: "queue-thread",
        });
        expect(queuedCritic).toBe(queuedResearcher);
        let queueEvents: RoutedChannelEvent[] = [];
        await waitForCondition(async () => {
          queueEvents = await readRoutedChannelEvents(server.url, "/queue/events");
          return queueEvents.filter((event) => event.type === "message.completed").length >= 2;
        }, "Timed out waiting for the mixed-target queue.");
        expect(
          queueEvents
            .filter((event) => event.type === "message.completed")
            .map((event) => event.message),
        ).toEqual(["QUEUE_RESEARCHER", "QUEUE_CRITIC"]);
        expect(new Set(queueEvents.map((event) => event.sessionId))).toEqual(
          new Set([queuedResearcher]),
        );

        const steeredResearcher = await sendRoutedChannel(server.url, "/steer", {
          agent: "researcher",
          message: "steer first",
          threadId: "steer-thread",
        });
        await waitForCondition(async () => {
          const events = await readRoutedChannelEvents(server.url, "/steer/events");
          return events.some((event) => event.type === "turn.started");
        }, "Timed out waiting for the steer source turn to start.");
        const steeredCritic = await sendRoutedChannel(server.url, "/steer", {
          agent: "researcher/critic",
          message: "steer critic",
          threadId: "steer-thread",
        });
        expect(steeredCritic).toBe(steeredResearcher);
        let steerEvents: RoutedChannelEvent[] = [];
        await waitForCondition(async () => {
          steerEvents = await readRoutedChannelEvents(server.url, "/steer/events");
          return (
            steerEvents.some((event) => event.type === "turn.cancelled") &&
            steerEvents.some((event) => event.message === "STEER_CRITIC")
          );
        }, "Timed out waiting for the mixed-target steer.");
        expect(
          steerEvents.some((event) => event.message === "STEER_RESEARCHER_SHOULD_CANCEL"),
        ).toBe(false);
        const steeredDefault = await sendRoutedChannel(server.url, "/steer", {
          message: "steer default",
          threadId: "steer-thread",
        });
        expect(steeredDefault).toBe(steeredResearcher);
        await waitForCondition(async () => {
          steerEvents = await readRoutedChannelEvents(server.url, "/steer/events");
          return steerEvents.some((event) => event.message === "STEER_RESEARCHER_DEFAULT");
        }, "Timed out waiting for the post-steer session default.");
        expect(new Set(steerEvents.map((event) => event.sessionId))).toEqual(
          new Set([steeredResearcher]),
        );

        await expectAgentRejection(server.url, "/researcher", 400, "invalid_agent_path");
        await expectAgentRejection(server.url, "missing", 404, "agent_not_found");
        await expectAgentRejection(server.url, "conditional", 400, "agent_not_directly_invocable");
        await expectAgentRejection(server.url, "remote", 400, "agent_not_directly_invocable");
      } catch (error) {
        throw new Error(`stdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`, {
          cause: error,
        });
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});

async function expectAgentRejection(
  serverUrl: string,
  agent: string,
  status: number,
  code: string,
): Promise<void> {
  const response = await fetch(new URL("/eve/v1/session", serverUrl), {
    body: JSON.stringify({ agent, message: "reject me" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({ code, ok: false });
}

interface RoutedChannelEvent {
  readonly message?: string;
  readonly sessionId: string;
  readonly type: string;
}

async function sendRoutedChannel(
  serverUrl: string,
  path: "/queue" | "/steer",
  body: { readonly agent?: string; readonly message: string; readonly threadId: string },
): Promise<string> {
  const response = await fetch(new URL(path, serverUrl), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  expect(response.status).toBe(202);
  return ((await response.json()) as { sessionId: string }).sessionId;
}

async function readRoutedChannelEvents(
  serverUrl: string,
  path: "/queue/events" | "/steer/events",
): Promise<RoutedChannelEvent[]> {
  return (await fetch(new URL(path, serverUrl)).then((response) =>
    response.json(),
  )) as RoutedChannelEvent[];
}
