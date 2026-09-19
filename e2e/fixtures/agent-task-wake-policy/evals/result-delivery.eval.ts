import { defineEval, type EveEvalTurn, type InputRequest } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description:
    "A scheduled send using auto overrides the cohort default: report A independently, withhold B until C finishes, then report B and C together.",
  timeoutMs: 120_000,
  async test(t) {
    if (!t.target.capabilities.devRoutes) {
      t.skip("Schedule dispatch requires dev routes.");
    }
    const dispatched = await t.target.dispatchSchedule("automatic-reports");
    await t.require(dispatched.sessionIds.length, equals(1));
    const launch = t.target.watchTurn(dispatched.sessionIds[0]!);
    const started = (await launch.result()).expectOk();
    started.calledSubagent("agent", { status: "working", count: 3 });
    let streamIndex = launch.session.state!.streamIndex;
    const requests = new Map<string, InputRequest>();
    const turns: EveEvalTurn[] = [started];
    collectRequests(started);
    for (let attempt = 0; requests.size < 3 && attempt < 8; attempt += 1)
      collectRequests(await nextTurn());
    await t.require([...requests.keys()].sort(), equals(["A", "B", "C"]));

    await release("A");
    (await through('["REPORT:A"]')).usedNoTools();

    await release("B");
    const partial = await throughCompletion("REPORT:B");
    partial.usedNoTools();
    await t.require(partial.message, equals(undefined));
    await post({
      message: "Alice checks the status while Bob's report C awaits her approval.",
      turnPolicy: "queue",
    });
    (await through("STATUS:AVAILABLE")).usedNoTools();

    await release("C");
    (await through('["REPORT:B","REPORT:C"]')).usedNoTools();
    const reports = turns
      .map((turn) => turn.message)
      .filter((message) => message?.startsWith('["REPORT:'));
    t.check(reports, equals(['["REPORT:A"]', '["REPORT:B","REPORT:C"]'])).label(
      "A reports once; B is retained until it can be combined with C",
    );
    for (const turn of turns) turn.noFailedActions();

    function collectRequests(turn: EveEvalTurn) {
      for (const request of turn.inputRequests) {
        const marker = request.action.input.marker;
        if (request.action.toolName === "release" && typeof marker === "string")
          requests.set(marker, request);
      }
    }

    async function release(marker: string) {
      await post({
        inputResponses: [{ requestId: requests.get(marker)!.requestId, optionId: "approve" }],
      });
    }

    async function post(body: unknown) {
      const response = await t.target.fetch(
        `/eve/v1/session/${encodeURIComponent(started.sessionId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: t.signal,
        },
      );
      await t.require(response.status, equals(202));
      await response.body?.cancel();
    }

    async function nextTurn() {
      const live = t.target.watchTurn(started.sessionId, { startIndex: streamIndex });
      const turn = (await live.result()).expectOk();
      streamIndex = live.session.state!.streamIndex;
      turns.push(turn);
      return turn;
    }

    async function throughCompletion(marker: string) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const turn = await nextTurn();
        if (
          turn.events.some(
            (event) =>
              event.type === "message.received" &&
              JSON.stringify(event.data.message).includes(marker),
          )
        )
          return turn;
      }
      throw new Error(`The parent did not receive ${marker}.`);
    }

    async function through(message: string) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const turn = await nextTurn();
        if (turn.message === message) return turn;
        if (turn.message?.startsWith('["REPORT:'))
          throw new Error(`Unexpected report: ${turn.message}`);
      }
      throw new Error(`The parent did not produce ${message}.`);
    }
  },
});
