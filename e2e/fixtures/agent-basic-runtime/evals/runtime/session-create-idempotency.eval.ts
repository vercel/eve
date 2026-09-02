import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

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
    const otherIssuer = await createSession(t.target, PRINCIPAL_B, operationId, message);

    const candidateTurns = await Promise.all(
      [...new Set([first.sessionId, concurrent.sessionId])].map((sessionId) =>
        t.target.watchTurn(sessionId).result(),
      ),
    );
    const ownerTurns = candidateTurns.filter((turn) =>
      turn.events.some((event) => event.type === "message.received"),
    );
    await t.require(
      ownerTurns,
      satisfies(
        (turns: typeof ownerTurns) => turns.length === 1,
        "only the operation owner runs the first turn",
      ),
    );
    const firstTurn = ownerTurns[0];
    if (firstTurn === undefined) throw new Error("No operation owner ran the first turn.");

    const replay = await createSession(t.target, PRINCIPAL_A, operationId, message);
    await t.require(replay.sessionId, equals(firstTurn.sessionId));
    await t.require(
      otherIssuer,
      satisfies(
        (value: CreateSessionResponse) => value.sessionId !== firstTurn.sessionId,
        "the same operation under another issuer owns a distinct session",
      ),
    );

    const issuerTurn = await t.target.watchTurn(otherIssuer.sessionId).result();
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
