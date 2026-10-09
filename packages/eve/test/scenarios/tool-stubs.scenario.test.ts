import { expect, it } from "vitest";
import { Client } from "../../src/client/client.js";
import type { MessageStreamEvent } from "../../src/protocol/message.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

it("separates stub creation permission from session access through compiled HTTP", async () => {
  const app = await scenarioApp({
    name: "declarative-tool-stubs",
    installDependencies: true,
    files: {
      "agent/instructions.md": "Help Alice deploy services.\n",
      "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({
  modelContextWindowTokens: 32000,
  model: mockModel(request => {
    const roles = request.messages.map(message => message.role);
    if (roles.lastIndexOf("tool") > roles.lastIndexOf("user")) return "Done";
    return { toolCalls: [{ name: "deploy", input: {
      service: request.lastUserMessage?.includes("web") ? "web" : "api", note: "Alice approved",
    } }] };
  }),
});`,
      "agent/tools/deploy.ts": `import { defineTool } from "eve/tools";
export default defineTool({
  description: "Deploy a service.",
  inputSchema: { type: "object", properties: { service: { type: "string" }, note: { type: "string" } }, required: ["service"] },
  execute: () => "live",
});`,
      "agent/channels/eve.ts": `import { httpBasic } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
export default eveChannel({
  auth: [httpBasic({ username: "alice", password: "fixture" }), httpBasic({ username: "bob", password: "fixture" })].map(authenticate => async request => {
    const auth = await authenticate(request);
    return auth ? { ...auth, allowToolStubs: auth.principalId === "alice" } : null;
  }),
});`,
    },
  });
  const server = await startEveDev(app.appRoot, {
    env: { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
  });
  try {
    const alice = new Client({
      host: server.url,
      auth: { basic: { username: "alice", password: "fixture" } },
    });
    const bob = new Client({
      host: server.url,
      auth: { basic: { username: "bob", password: "fixture" } },
    });
    const stubs = [
      {
        id: "deploy",
        tool: "deploy",
        match: { service: { const: "api" } },
        outcomes: [{ response: "pending" }, { response: "completed" }] as const,
      },
    ];
    for (const tool of ["deply", "unknown/deploy", "deploy/child"]) {
      const invalid = await alice.fetch("/eve/v1/session", {
        method: "POST",
        body: JSON.stringify({ stubs: [{ id: "typo", tool, outcome: { response: "fake" } }] }),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: expect.stringContaining(tool) });
    }
    const { session } = await alice.sessions.create({ stubs });
    const path = `/eve/v1/session/${session.state.sessionId}`;
    const forbidden = await bob.fetch("/eve/v1/session", {
      method: "POST",
      body: JSON.stringify({ stubs }),
    });
    expect(forbidden.status).toBe(403);

    const first = await (await session.send("Alice asks to deploy api.")).result();
    expect(results(first.events)).toEqual(["pending"]);
    const shared = bob.sessions.attach(session.state.sessionId, {
      streamIndex: session.state.streamIndex,
    });
    const next = await (await shared.send("Bob asks for another api deployment.")).result();
    expect(results(next.events)).toEqual(["completed"]);
    const exhausted = await (await shared.send("Bob asks for one more api deployment.")).result();
    expect(results(exhausted.events)).toEqual(["completed"]);
    const live = await (await shared.send("Bob asks to deploy web.")).result();
    expect(results(live.events)).toEqual(["live"]);
    expect((await bob.fetch(path + "/stubs")).status).toBe(403);
    const status = await alice.fetch(path + "/stubs");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ error: null, matchedRuleIds: ["deploy"] });
    const { session: recovery } = await alice.sessions.create({
      stubs: [
        {
          id: "retry",
          tool: "deploy",
          outcomes: [
            { throw: { name: "TimeoutError", message: "Deployment service timed out" } },
            { response: "recovered" },
          ],
        },
      ],
    });
    const failed = await (await recovery.send("Alice asks to deploy api.")).result();
    expect(failed.events).toContainEqual(
      expect.objectContaining({
        type: "action.result",
        data: expect.objectContaining({
          status: "failed",
          result: expect.objectContaining({
            toolName: "deploy",
            output: expect.stringContaining("Deployment service timed out"),
          }),
        }),
      }),
    );
    const retried = await (await recovery.send("Alice asks to deploy api again.")).result();
    expect(results(retried.events)).toEqual(["recovered"]);
    const verification = await alice.fetch(`/eve/v1/session/${recovery.state.sessionId}/stubs`);
    expect(await verification.json()).toEqual({ error: null, matchedRuleIds: ["retry"] });
    const replacement = await bob.fetch(path, {
      method: "POST",
      body: JSON.stringify({ message: "Next", stubs }),
    });
    expect(replacement.status).toBe(400);

    const invalid = await alice.fetch("/eve/v1/session", {
      method: "POST",
      body: JSON.stringify({
        stubs: [
          {
            id: "bad",
            tool: "deploy",
            match: { service: { type: "strng" } },
            outcome: { response: null },
          },
        ],
      }),
    });
    expect(invalid.status).toBe(400);
    const { session: overlapping } = await alice.sessions.create({
      stubs: [
        { id: "a", tool: "deploy", outcome: { response: "a" } },
        { id: "b", tool: "deploy", outcome: { response: "b" } },
      ],
    });
    const selected = await (await overlapping.send("Alice asks to deploy api.")).result();
    expect(results(selected.events)).toEqual(["a"]);
    const failure = await alice.fetch(`/eve/v1/session/${overlapping.state.sessionId}/stubs`);
    expect(failure.status).toBe(200);
    expect(await failure.json()).toEqual({ error: null, matchedRuleIds: ["a"] });
  } finally {
    await server.stop();
  }
}, 360_000);

function results(events: readonly MessageStreamEvent[]): unknown[] {
  return events.flatMap((event) =>
    event.type === "action.result" &&
    event.data.result.kind === "tool-result" &&
    event.data.result.toolName === "deploy"
      ? [event.data.result.output]
      : [],
  );
}
