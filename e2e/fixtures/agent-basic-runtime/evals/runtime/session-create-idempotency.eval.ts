import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

interface CreateSessionResponse {
  readonly continuationToken: string;
  readonly ok: true;
  readonly sessionId: string;
}

const PRINCIPAL_A = "Bearer e2e-create-once-a";
const PRINCIPAL_B = "Bearer e2e-create-once-b";

export default defineEval({
  description:
    "Concurrent and serial create retries dispatch once and remain isolated across issuers.",
  async test(t) {
    const operationId = `session-create-idempotency-${crypto.randomUUID()}`;
    const message = `CREATE-ONCE-INITIAL-${crypto.randomUUID()}`;
    const [first, concurrent] = await Promise.all([
      createSession(t.target, PRINCIPAL_A, operationId, message),
      createSession(t.target, PRINCIPAL_A, operationId, message),
    ]);
    const replay = await createSession(t.target, PRINCIPAL_A, operationId, message);
    const otherIssuer = await createSession(t.target, PRINCIPAL_B, operationId, message);

    for (const retry of [concurrent, replay]) {
      await t.require(retry.sessionId, equals(first.sessionId));
      await t.require(retry.continuationToken, equals(first.continuationToken));
    }
    await t.require(
      otherIssuer,
      satisfies(
        (value: CreateSessionResponse) =>
          value.sessionId !== first.sessionId &&
          value.continuationToken !== first.continuationToken,
        "the same operation under another issuer owns a distinct session",
      ),
    );

    const [firstTurn, issuerTurn] = await Promise.all([
      t.target.watchTurn(first.sessionId).result(),
      t.target.watchTurn(otherIssuer.sessionId).result(),
    ]);
    firstTurn.expectOk();
    firstTurn.event("message.received", { count: 1, data: { message } });
    firstTurn.event("step.started", { count: 1 });
    issuerTurn.expectOk();
    issuerTurn.event("message.received", { count: 1, data: { message } });
    issuerTurn.event("step.started", { count: 1 });

    const probe = `CREATE-ONCE-PROBE-${crypto.randomUUID()}`;
    const liveProbe = t.target.watchTurn(first.sessionId, { startIndex: firstTurn.events.length });
    await continueSession(t.target, PRINCIPAL_A, first.sessionId, first.continuationToken, probe);
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
  continuationToken: string,
  message: string,
): Promise<void> {
  const response = await target.fetch(`/eve/v1/session/${encodeURIComponent(sessionId)}`, {
    body: JSON.stringify({ continuationToken, message }),
    headers: { authorization, "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`POST continuation failed (${response.status}): ${await response.text()}`);
  }
}
