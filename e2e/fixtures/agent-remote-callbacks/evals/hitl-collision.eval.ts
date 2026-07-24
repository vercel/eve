import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const CODE = "hitl-collide-3J9K";
const CREDENTIAL = `PROBE-CREDENTIAL-${CODE}`;
const GATE_MARKER = "GATE-RELEASED-7Q4Z";

/**
 * HITL and remote-callback collision: one turn holds a pending tool
 * approval (`release_gate`) and an in-flight remote call at the same
 * time. While the caller is parked on the approval, the remote callee's
 * authorization notifications and terminal callback arrive and must be
 * held against the pending call — never consumed as the approval answer
 * — and answering the approval must not resolve the remote call.
 *
 * The callee's authorization hook is completed while the caller is
 * parked for input. The hook URL is derived instead of read from the
 * stream (the caller's turn stream parks at the approval, so the
 * forwarded `authorization.required` cannot be observed live): the hook
 * token is the deterministic `<childSessionId>:auth` and the callee runs
 * on this same deployment.
 */
export default defineEval({
  description: "A pending approval and remote callbacks in one turn resolve independently.",
  timeoutMs: 600_000,

  async test(t) {
    const live = await t.start(
      `In one single response, request both of these in parallel: (1) call the release_gate tool, and (2) call the probe-remote subagent with message 'Acquire the probe credential and reply with the credential string verbatim.'. When calling the subagent, pass only the message field; never provide the outputSchema field. After both finish, reply with the gate marker and the credential string, both verbatim. Do not call anything else.`,
    );

    // As soon as the callee parks on its authorization hook, complete it.
    // The subagent.called waiter rejects if the turn parks for input
    // before the remote is dispatched (the calls were not parallel), so
    // resolve to false and fail through the require below.
    const authorized = (async (): Promise<boolean> => {
      const called = await live.waitForEvent("subagent.called", {
        data: { name: "probe-remote" },
      });
      t.log(`remote dispatched: child session ${called.data.childSessionId}`);
      const token = encodeURIComponent(`${called.data.childSessionId}:auth`);
      // Plain fetch on a fully-built URL: the connection callback route is
      // public (it is an IdP redirect target), and `t.target.fetch` treats
      // its whole `path` argument as pathname, mangling a `?code=` query.
      const hook = new URL(`/eve/v1/connections/probe/callback/${token}`, t.target.url);
      hook.searchParams.set("code", CODE);
      for (let attempt = 0; attempt < 180; attempt += 1) {
        const response = await fetch(hook, { redirect: "manual" });
        if (response.ok) {
          t.log(`authorization hook accepted after ${attempt + 1} attempt(s)`);
          return true;
        }
        await t.sleep(1_000);
      }
      return false;
    })().catch((error: unknown) => {
      t.log(`authorization hook flow failed: ${String(error)}`);
      return false;
    });

    // The approval must surface while the remote call is in flight.
    await live.waitForEvent("input.requested");
    t.log("approval request observed on the live stream");
    await live.result();
    t.log("turn parked at the approval");
    t.requireInputRequest({ toolName: "release_gate" });

    // Complete the callee's authorization while the caller stays parked
    // on the approval, so its notification and terminal callbacks land
    // against a turn that is waiting for human input.
    await t.require(await authorized, equals(true));
    t.log("responding to the approval");

    const resumed = await t.respondAll("approve");
    t.check(resumed.inputRequests, equals([]));

    t.succeeded();
    t.noFailedActions();
    t.calledSubagent("probe-remote", { output: new RegExp(CREDENTIAL), count: 1 });
    t.calledTool("release_gate", { output: new RegExp(GATE_MARKER) });
    t.messageIncludes(CREDENTIAL);
    t.messageIncludes(GATE_MARKER);
    t.check(t.pendingInputRequests, equals([]));
  },
});
