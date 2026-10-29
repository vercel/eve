import { describe, expect, it } from "vitest";

import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { EVE_SESSION_ID_HEADER } from "../../src/protocol/session-http.js";
import { type RunningEveDev, startEveDev } from "./dev-server-harness.js";

/**
 * Two HTTP creates that race for one `operationId` must both answer with the id of the session
 * that ends up owning the operation. A follow-up sent to that id right away must reach it once.
 */

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 360_000;
const TOKEN = "create-race-token";
const TRIALS = 10;

const DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(({ userMessages }) => "saw: " + userMessages.at(-1)),
  modelContextWindowTokens: 32_000,
});
`,
    "agent/channels/eve.ts": `import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth(request) {
    if (request.headers.get("authorization") !== "Bearer ${TOKEN}") return null;
    return {
      attributes: {},
      authenticator: "scenario-bearer",
      principalId: "caller",
      principalType: "service",
    };
  },
});
`,
    "agent/instructions.md": "Reply tersely.\n",
  },
  installDependencies: true,
  name: "eve-channel-create-race",
};

const HEADERS = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

interface CreateResult {
  readonly headerSessionId: string | null;
  readonly sessionId: string | undefined;
  readonly status: number;
}

async function create(server: RunningEveDev, operationId: string): Promise<CreateResult> {
  const response = await fetch(new URL("/eve/v1/session", server.url), {
    body: JSON.stringify({ operationId }),
    headers: HEADERS,
    method: "POST",
  });
  const body = (await response.json()) as { sessionId?: string };
  return {
    headerSessionId: response.headers.get(EVE_SESSION_ID_HEADER),
    sessionId: body.sessionId,
    status: response.status,
  };
}

/** Sends a follow-up and returns its status with the body, so a failure shows the answer. */
async function send(server: RunningEveDev, sessionId: string, text: string): Promise<string> {
  const response = await fetch(new URL(`/eve/v1/session/${sessionId}`, server.url), {
    body: JSON.stringify({ message: text, turnPolicy: "queue" }),
    headers: HEADERS,
    method: "POST",
  });
  return `${response.status} ${await response.text()}`;
}

/** Counts the recorded deliveries on the session's stream whose text is `text`. */
async function countConsumed(
  server: RunningEveDev,
  sessionId: string,
  text: string,
): Promise<number> {
  const response = await fetch(
    new URL(`/eve/v1/session/${sessionId}/stream?startIndex=0&follow=0`, server.url),
    { headers: HEADERS, signal: AbortSignal.timeout(30_000) },
  );
  expect(response.status, server.stderr()).toBe(200);
  const lines = (await response.text()).split("\n").filter((line) => line.trim() !== "");
  let count = 0;
  for (const line of lines) {
    const batch = JSON.parse(line) as {
      facts?: readonly {
        data?: { parts?: readonly { kind: string; text?: string }[] };
        type: string;
      }[];
    };
    for (const fact of batch.facts ?? []) {
      if (fact.type !== "delivery.consumed") continue;
      if (fact.data?.parts?.some((part) => part.kind === "text" && part.text === text)) count++;
    }
  }
  return count;
}

async function waitForConsumed(
  server: RunningEveDev,
  sessionId: string,
  text: string,
): Promise<number> {
  const deadline = Date.now() + 30_000;
  let count = 0;
  while (Date.now() < deadline) {
    count = await countConsumed(server, sessionId, text);
    if (count > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return count;
}

describe("eve channel create with an operationId", () => {
  it(
    "answers concurrent creates with the owner's id, and a single create with its own",
    async () => {
      const app = await scenarioApp(DESCRIPTOR);
      const server = await startEveDev(app.appRoot);
      try {
        for (let trial = 0; trial < TRIALS; trial++) {
          const operationId = `op_${crypto.randomUUID()}`;
          const [first, second] = await Promise.all([
            create(server, operationId),
            create(server, operationId),
          ]);
          const detail = `trial ${trial}: ${JSON.stringify({ first, second })}\n${server.stderr()}`;
          expect(first.status, detail).toBe(202);
          expect(second.status, detail).toBe(202);
          expect(first.sessionId, detail).toBeTruthy();
          expect(second.sessionId, detail).toBe(first.sessionId);
          expect(first.headerSessionId, detail).toBe(first.sessionId);
          expect(second.headerSessionId, detail).toBe(first.sessionId);

          const text = `follow-up ${trial}`;
          expect(await send(server, first.sessionId!, text), detail).toMatch(/^202 /);
          expect(await waitForConsumed(server, first.sessionId!, text), detail).toBe(1);

          const existing = await create(server, operationId);
          expect(existing.status, detail).toBe(202);
          expect(existing.sessionId, detail).toBe(first.sessionId);
        }

        const single = await create(server, `op_single_${crypto.randomUUID()}`);
        expect(single.status, server.stderr()).toBe(202);
        expect(single.sessionId).toBeTruthy();
        expect(single.headerSessionId).toBe(single.sessionId);
        expect(await send(server, single.sessionId!, "single")).toMatch(/^202 /);
        expect(await waitForConsumed(server, single.sessionId!, "single")).toBe(1);
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});
