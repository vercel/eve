import { Client } from "eve/client";
import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { equals } from "eve/evals/expect";

const ECHO_TOKEN = "SUBAGENT_TOKEN=echo-marker-9F2X";
const NESTED_TOKEN = "NESTED_DIRECT_TOKEN=critic-4M7Q";

interface AcceptedResponse {
  readonly code?: string;
  readonly ok?: boolean;
  readonly sessionId?: string;
  readonly status?: string;
}

export default defineEval({
  description:
    "Static descendants can be invoked directly through HTTP, the client, and a custom channel.",
  tags: ["real-model"],
  timeoutMs: 240_000,

  async test(t) {
    const directCreate = await postJson<AcceptedResponse>(
      t.target,
      "/eve/v1/session",
      { agent: "echo-marker", message: "Direct creation." },
      202,
    );
    const directSessionId = requireSessionId(directCreate);
    const directTurn = await t.target.watchTurn(directSessionId).result();
    directTurn.expectOk();
    await t.require(directTurn.message, equals(ECHO_TOKEN));
    directTurn.notEvent("subagent.called");
    directTurn.notEvent("subagent.completed");

    const rootCreate = await postJson<AcceptedResponse>(
      t.target,
      "/eve/v1/session",
      { message: "Reply with exactly ROOT-DIRECT-READY." },
      202,
    );
    const rootSessionId = requireSessionId(rootCreate);
    const rootTurn = await t.target.watchTurn(rootSessionId).result();
    rootTurn.expectOk();
    rootTurn.messageIncludes(/ROOT-DIRECT-READY/i);

    const targetedWatch = t.target.watchTurn(rootSessionId, {
      startIndex: rootTurn.events.length,
    });
    const targeted = await postJson<AcceptedResponse>(
      t.target,
      `/eve/v1/session/${encodeURIComponent(rootSessionId)}`,
      { agent: "echo-marker", message: "Run this turn directly." },
      202,
    );
    await t.require(targeted.sessionId, equals(rootSessionId));
    const targetedTurn = await targetedWatch.result();
    targetedTurn.expectOk();
    await t.require(targetedTurn.message, equals(ECHO_TOKEN));

    const client = new Client({ host: t.target.url });
    const clientCreate = await client.sessions.create({
      agent: "echo-marker",
      message: "Create through the TypeScript client.",
    });
    const clientDefault = await clientCreate.response.result();
    await t.require(clientDefault.message, equals(ECHO_TOKEN));
    const nested = await clientCreate.session
      .send("Invoke the nested marker for one turn.", {
        agent: "echo-marker/nested-marker",
      })
      .then((response) => response.result());
    await t.require(nested.message, equals(NESTED_TOKEN));
    await t.require(nested.sessionId, equals(clientDefault.sessionId));
    const returnedToDefault = await clientCreate.session
      .send("Return to the direct session default.")
      .then((response) => response.result());
    await t.require(returnedToDefault.message, equals(ECHO_TOKEN));

    const threadId = crypto.randomUUID();
    const channelCreate = await postJson<AcceptedResponse>(
      t.target,
      "/direct-agent",
      { agent: "echo-marker", message: "Dispatch from a slash command.", threadId },
      202,
    );
    const channelSessionId = requireSessionId(channelCreate);
    const channelTurn = await t.target.watchTurn(channelSessionId).result();
    channelTurn.expectOk();
    await t.require(channelTurn.message, equals(ECHO_TOKEN));
    await waitForOwner(t.target, `handled:${channelSessionId}`, channelSessionId);

    await expectRejection(t.target, "/echo-marker", 400, "invalid_agent_path");
    await expectRejection(t.target, "missing", 404, "agent_not_found");
    await expectRejection(t.target, "conditional-marker", 400, "agent_not_directly_invocable");
    await expectRejection(t.target, "remote-loopback", 400, "agent_not_directly_invocable");
  },
});

async function postJson<T>(
  target: EveEvalTargetHandle,
  path: string,
  body: unknown,
  expectedStatus: number,
): Promise<T> {
  const response = await target.fetch(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(
      `POST ${path} returned ${response.status}, expected ${expectedStatus}: ${text}`,
    );
  }
  return JSON.parse(text) as T;
}

function requireSessionId(response: AcceptedResponse): string {
  if (response.ok !== true || response.status !== "accepted" || response.sessionId === undefined) {
    throw new Error(`Expected an accepted session response, received ${JSON.stringify(response)}.`);
  }
  return response.sessionId;
}

async function expectRejection(
  target: EveEvalTargetHandle,
  agent: string,
  status: number,
  code: string,
): Promise<void> {
  const response = await postJson<AcceptedResponse>(
    target,
    "/eve/v1/session",
    { agent, message: "Reject this direct invocation." },
    status,
  );
  if (response.ok !== false || response.code !== code) {
    throw new Error(`Expected ${code}, received ${JSON.stringify(response)}.`);
  }
}

async function waitForOwner(
  target: EveEvalTargetHandle,
  address: string,
  expectedSessionId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const owner = await postJson<{ sessionId: string | null }>(
      target,
      "/direct-agent/owner",
      { address },
      200,
    );
    if (owner.sessionId === expectedSessionId) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Channel event handler did not rekey ${expectedSessionId}.`);
}
