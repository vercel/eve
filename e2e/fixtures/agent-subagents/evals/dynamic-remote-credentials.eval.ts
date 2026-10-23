import { endsTurn, type SessionStreamEvent } from "eve/client";
import { calls, emptySessionView, foldEvents } from "eve/events";
type ChildOpened = Extract<SessionStreamEvent, { type: "child.opened" }>;
import { defineEval, type EveEvalContext, type EveEvalSession, type EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { TENANT_REMOTE_DIRECTIVE } from "../constants";

const BOB_AUTHORIZATION = "Bearer e2e-workspace-label-bob";
const ACME = "current=service:tenant-acme";

/**
 * A dynamic remote agent renders its credentials from what it recorded for the caller. A child
 * keeps the record it was opened with: when Bob, whose tenant is Globex, continues Alice's child,
 * it still runs as Acme rather than switching tenants mid-conversation. Every read goes through
 * the parent's stream proxy, which the fixture's channel serves only with a tenant's bearer, so
 * the proxy must render the child's credentials too.
 */
export default defineEval({
  tags: ["dynamic-remote"],
  description:
    "A dynamic remote child keeps its opening credentials for another caller's continuation and for the stream proxy.",
  async test(t) {
    // Alice opens the child: it runs as her tenant, Acme.
    const opened = await t.send(`${TENANT_REMOTE_DIRECTIVE} Use the tenant-remote agent.`);
    opened.expectOk();
    const child = await requireChild(t, opened);
    const taskId = child.scope?.taskId;
    if (taskId === undefined) throw new Error("The tenant-remote child opened outside a task.");
    const first = await readChildTurn(opened.session, child, 0);
    await expectWhoami(t, first.events, "the opening call runs as Acme, read through the proxy");

    // Bob continues the same child. His tenant is Globex, but the child keeps Acme's credentials.
    const continued = await opened.session.send(
      `${TENANT_REMOTE_DIRECTIVE} A different user asks now. Continue the tenant-remote agent using its taskId.`,
      { headers: { authorization: BOB_AUTHORIZATION } },
    );
    continued.expectOk();
    continued.event("call.started", { data: { taskId } });
    continued.notEvent("child.opened");
    const second = await readChildTurn(opened.session, child, first.next);
    await expectWhoami(t, second.events, "the continuation still runs as Acme");
    t.succeeded();
  },
});

/** One child turn through the parent's proxy, from `startIndex`, and where the next one starts. */
async function readChildTurn(
  session: EveEvalSession,
  child: ChildOpened,
  startIndex: number,
): Promise<{ readonly events: readonly SessionStreamEvent[]; readonly next: number }> {
  const events: SessionStreamEvent[] = [];
  let next = startIndex;
  for await (const event of session.agent(child).stream({ startIndex })) {
    events.push(event);
    next = event.meta.position.line + 1;
    if (endsTurn(event)) break;
  }
  return { events, next };
}

async function expectWhoami(
  t: EveEvalContext,
  events: readonly SessionStreamEvent[],
  label: string,
): Promise<void> {
  await t.require(
    events,
    satisfies((read: readonly SessionStreamEvent[]) => {
      const whoami = calls(foldEvents(emptySessionView(), read)).filter(
        (call) => call.name === "whoami" && call.outcome === "completed",
      );
      return (
        whoami.length > 0 && whoami.every((call) => JSON.stringify(call.output).includes(ACME))
      );
    }, label),
  );
}

/** The parent may finish its turn before recording the child; wait for it on the stream if so. */
async function requireChild(t: EveEvalContext, turn: EveEvalTurn): Promise<ChildOpened> {
  for (const event of turn.events) {
    if (event.type === "child.opened" && event.data.name === "tenant-remote") return event;
  }
  return await t.target
    .attach(turn.sessionId, { startIndex: turn.session.state.streamIndex })
    .watch()
    .waitForEvent("child.opened", { data: { name: "tenant-remote" } });
}
