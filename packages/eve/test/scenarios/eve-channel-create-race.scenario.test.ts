import { describe, expect, it } from "vitest";

import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { EVE_SESSION_ID_HEADER } from "../../src/protocol/session-http.js";
import { type RunningEveDev, startEveDev, waitForCondition } from "./dev-server-harness.js";

/**
 * Two HTTP creates that race for one `operationId` may answer with different session ids, only one
 * of which ends up owning the operation. A follow-up sent right away to either id must reach the
 * owner exactly once, or be refused; it must never be accepted and then lost.
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

/** Sends a follow-up, retrying `session_not_ready` on the schedule a caller like the hub uses. */
async function sendWhenReady(server: RunningEveDev, sessionId: string, text: string) {
  let answer = await send(server, sessionId, text);
  for (const waitMs of [250, 500, 1_000, 2_000]) {
    if (!answer.includes("session_not_ready")) break;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    answer = await send(server, sessionId, text);
  }
  return answer;
}

describe("eve channel create with an operationId", () => {
  it(
    "never loses a follow-up sent right away to either of two racing creates",
    async () => {
      const app = await scenarioApp(DESCRIPTOR);
      const server = await startEveDev(app.appRoot);
      try {
        let acceptedByLoser = 0;
        for (let trial = 0; trial < TRIALS; trial++) {
          const operationId = `op_${crypto.randomUUID()}`;
          const created = await Promise.all([
            create(server, operationId),
            create(server, operationId),
          ]);
          let answers: string[] = [];
          const detail = () =>
            `trial ${trial}: ${JSON.stringify({ created, answers })}\n${server.stderr()}`;
          for (const result of created) {
            expect(result.status, detail()).toBe(202);
            expect(result.headerSessionId, detail()).toBe(result.sessionId);
          }
          answers = await Promise.all(
            created.map((result, index) =>
              sendWhenReady(server, result.sessionId!, `follow-up ${trial}.${index}`),
            ),
          );

          const owner = (await create(server, operationId)).sessionId!;
          for (const [index, answer] of answers.entries()) {
            // A follow-up is either refused, so the caller knows to resend, or reaches the owner.
            if (!answer.startsWith("202 ")) {
              expect(answer, detail()).toMatch(/^409 .*session_not_active/);
              continue;
            }
            if (created[index]!.sessionId !== owner) acceptedByLoser++;
            const text = `follow-up ${trial}.${index}`;
            await waitForCondition(
              async () => (await countConsumed(server, owner, text)) > 0,
              () => `"${text}" was accepted but never reached the owner ${owner}\n${detail()}`,
              30_000,
            );
            expect(await countConsumed(server, owner, text), detail()).toBe(1);
          }
        }
        // The race this test is about: a run that lost the operation accepted a follow-up.
        expect(acceptedByLoser, server.stderr()).toBeGreaterThan(0);
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});
