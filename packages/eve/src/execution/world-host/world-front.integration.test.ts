import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "#client/index.js";
import type { EveAuthFn } from "#eve-channel/types.js";
import { localWorld } from "#execution/world/local-world.js";
import type { QueueWorld } from "#execution/world/runtime-world.js";
import { EVE_SESSION_ROUTE_PATH } from "#protocol/routes.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { defineAgent } from "#public/definitions/agent.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import { createWorldHost, type WorldHost } from "./host.js";
import { createWorldFront as createFront, type WorldFront } from "./world-front.js";

// A client that knows only a URL and a token, against a World host's front: the front knows its
// agent only by name and serves eve's channel; a host that has the agent's definition runs the
// sessions when their wakes arrive. `eve/client` reaches the front through its `fetch`, as it
// would a deployment over HTTP.

const TOKEN = "alice-token";
/** Verifies the bearer token, as `eve/channels/auth`'s verifiers do: the caller is Alice. */
const bearer: EveAuthFn = async (request) =>
  request.headers.get("authorization") === `Bearer ${TOKEN}`
    ? { attributes: {}, authenticator: "test", principalId: "alice", principalType: "user" }
    : null;

function releaseAgent(ran: unknown[]) {
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        if (prompt.at(-1)?.role === "tool") return textStreamResult("Deployed.");
        if (JSON.stringify(prompt.at(-1)).includes("Ship it"))
          return toolCallsStreamResult([
            { input: '{"env":"prod"}', toolCallId: "call-1", toolName: "deploy" },
          ]);
        return textStreamResult("Hello from the World.");
      },
      modelId: "world-front-scripted",
      provider: "eve-test",
    }),
  );
  return defineAgent({
    model,
    modelContextWindowTokens: 200_000,
    name: "release",
    tools: {
      deploy: defineTool({
        approval: always(),
        description: "Deploy.",
        execute: async (input: Record<string, unknown>, ctx) => {
          ran.push({ input, who: ctx.session.auth.current?.principalId });
          return { ok: true };
        },
        inputSchema: { properties: { env: { type: "string" } }, type: "object" },
      }),
    },
  });
}

let dir: string;
let world: QueueWorld;
let host: WorldHost | undefined;
const fronts: WorldFront[] = [];
/** A front, closed after the test. */
const createWorldFront = (...args: Parameters<typeof createFront>): WorldFront => {
  const front = createFront(...args);
  fronts.push(front);
  return front;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eve-world-front-"));
  world = localWorld({ dataDir: join(dir, "world") });
});
afterEach(async () => {
  for (const front of fronts.splice(0)) await front.close();
  await host?.close();
  host = undefined;
  await world.close?.();
  rmSync(dir, { force: true, recursive: true });
});

/** The workers: a host with the agent's definition, consuming the World's wakes. */
async function workers(ran: unknown[]): Promise<WorldHost> {
  host = createWorldHost({ agents: [releaseAgent(ran)], world });
  await host.serve();
  return host;
}

describe("a World host's front", () => {
  it("serves eve's channel to a client that knows only a URL and a token", async () => {
    const ran: unknown[] = [];
    await workers(ran);
    const front = createWorldFront({ agents: ["release"], world });
    const handler = front.eveChannel("release", { auth: [bearer] });
    const fetch: typeof globalThis.fetch = async (input, init) =>
      await handler(new Request(input, init));
    const client = new Client({ auth: { bearer: TOKEN }, baseUrl: "http://front.test", fetch });

    expect((await client.health()).ok).toBe(true);
    // Without the token, nothing is created.
    const refused = await new Client({ baseUrl: "http://front.test", fetch }).fetch(
      EVE_SESSION_ROUTE_PATH,
      { body: JSON.stringify({ message: "Ship it." }), method: "POST" },
    );
    expect(refused.status).toBe(401);

    const { delivery, session } = await client.sessions.create({ message: "Ship it." });
    const first = await delivery.result();
    expect(first.status).toBe("awaiting-input");
    const approval = first.interactions.find((interaction) => interaction.status === "open")!;
    expect(approval.call?.name).toBe("deploy");

    // Answered in a later activation, wherever the World delivers it.
    const answered = await session.respond([
      { interactionId: approval.interactionId, optionId: "approve" },
    ]);
    expect(await answered.result()).toMatchObject({ reply: "Deployed.", status: "completed" });
    // The session's identity is the caller the token verified.
    expect(ran).toEqual([{ input: { env: "prod" }, who: "alice" }]);

    expect(await (await session.send("Hi.")).result()).toMatchObject({
      reply: "Hello from the World.",
      status: "completed",
    });
    await session.cancel();
    await session.clear();
    expect(await (await session.send("Again.")).result()).toMatchObject({
      reply: "Hello from the World.",
      status: "completed",
    });

    const types: string[] = [];
    for await (const event of session.stream({ follow: false, startIndex: 0 }))
      types.push(event.type);
    expect(types[0]).toBe("session.started");
    expect(types).toContain("interaction.opened");
  });

  it("keeps nothing of a session once it ends when its agent's retention is 0", async () => {
    await workers([]);
    const front = createWorldFront({ agents: [{ name: "release", retention: 0 }], world });
    const handler = front.eveChannel("release", { auth: [bearer] });
    const client = new Client({
      auth: { bearer: TOKEN },
      baseUrl: "http://front.test",
      fetch: async (input, init) => await handler(new Request(input, init)),
    });
    const { delivery, session } = await client.sessions.create({ message: "Hi." });
    expect((await delivery.result()).reply).toBe("Hello from the World.");
    await session.end();
    const deadline = Date.now() + 15_000;
    while (!(await front.entities.purged(session.id))) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });

  it("knows only the agents it's given", () => {
    const front = createWorldFront({ agents: ["release"], world });
    expect(() => front.eveChannel("other", { auth: [bearer] })).toThrow(/no agent "other"/);
    expect(() => createWorldFront({ agents: ["a", { name: "a" }], world })).toThrow(/named "a"/);
  });
});
