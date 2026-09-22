import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { satisfies } from "eve/evals/expect";

interface CreateSessionResponse {
  readonly ok: true;
  readonly sessionId: string;
  readonly status: "accepted";
}

const PRINCIPAL_A = "Bearer e2e-create-once-a";
const PRINCIPAL_B = "Bearer e2e-create-once-b";

export default defineEval({
  description:
    "Concurrent create candidates converge on one owner, serial retries resolve it, and issuers remain isolated.",
  async test(t) {
    const operationId = `session-create-idempotency-${crypto.randomUUID()}`;
    const message = `CREATE-ONCE-INITIAL-${crypto.randomUUID()}`;
    const [first, concurrent] = await Promise.all([
      createSession(t.target, PRINCIPAL_A, operationId, message),
      createSession(t.target, PRINCIPAL_A, operationId, message),
    ]);

    const acceptedCandidates = new Set([first.sessionId, concurrent.sessionId]);
    let replay: CreateSessionResponse | undefined;
    for (const delayMs of [100, 200, 400, 800, 1_600]) {
      await t.sleep(delayMs);
      const retry = await createSession(t.target, PRINCIPAL_A, operationId, message);
      if (acceptedCandidates.has(retry.sessionId)) {
        replay = retry;
        break;
      }
      acceptedCandidates.add(retry.sessionId);
    }
    if (replay === undefined) {
      throw new Error("The operation owner was not resolvable after startup.");
    }

    const otherIssuer = await createSession(t.target, PRINCIPAL_B, operationId, message);
    await t.require(
      otherIssuer,
      satisfies(
        (value: CreateSessionResponse) => value.sessionId !== replay.sessionId,
        "the same operation under another issuer owns a distinct session",
      ),
    );

    const [firstTurn, issuerTurn] = await Promise.all([
      t.target.watchTurn(replay.sessionId).result(),
      t.target.watchTurn(otherIssuer.sessionId).result(),
    ]);
    firstTurn.expectOk();
    firstTurn.event("message.received", { count: 1, data: { message } });
    firstTurn.event("step.started", { count: 1 });
    issuerTurn.expectOk();
    issuerTurn.event("message.received", { count: 1, data: { message } });
    issuerTurn.event("step.started", { count: 1 });

    const probe = `CREATE-ONCE-PROBE-${crypto.randomUUID()}`;
    const liveProbe = t.target.watchTurn(firstTurn.sessionId, {
      startIndex: firstTurn.events.length,
    });
    await continueSession(t.target, PRINCIPAL_A, firstTurn.sessionId, probe);
    const probeTurn = await liveProbe.result();
    probeTurn.expectOk();
    probeTurn.event("message.received", { count: 1, data: { message: probe } });
    probeTurn.event("step.started", { count: 1 });
  },
});

async function createSession(
  target: EveEvalTargetHandle,
  authorization: string,
  operationId: string,
  message: string,
): Promise<CreateSessionResponse> {
  const response = await target.fetch("/eve/v1/session", {
    body: JSON.stringify({ message, operationId }),
    headers: { authorization, "content-type": "application/json" },
    method: "POST",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST /eve/v1/session failed (${response.status}): ${text}`);
  return JSON.parse(text) as CreateSessionResponse;
}

async function continueSession(
  target: EveEvalTargetHandle,
  authorization: string,
  sessionId: string,
  message: string,
): Promise<void> {
  const response = await target.fetch(`/eve/v1/session/${encodeURIComponent(sessionId)}`, {
    body: JSON.stringify({ message }),
    headers: { authorization, "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`POST continuation failed (${response.status}): ${await response.text()}`);
  }
}
