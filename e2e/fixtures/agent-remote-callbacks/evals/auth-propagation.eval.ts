import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const CODE = "auth-prop-9F2X";
const CREDENTIAL = `PROBE-CREDENTIAL-${CODE}`;

/**
 * Remote authorization propagation, end to end: the remote callee's
 * `acquire_probe_credential` tool parks on an authorization hook, the
 * `authorization.required` event rides a notification callback to the
 * caller's notification consumer — which re-emits it wrapped as
 * `subagent.event` — this eval completes the hook with a `?code=` the same
 * way a person would follow the sign-in link, and the code travels back
 * through the callee's resume into the terminal callback — so the
 * credential in the caller's final reply proves the full loop.
 */
export default defineEval({
  description: "Remote callee authorization lifecycle propagates to the caller and back.",
  timeoutMs: 600_000,

  async test(t) {
    const live = await t.start(
      `Call the probe-remote subagent exactly once with message 'Acquire the probe credential and reply with the credential string verbatim.'. Pass only the message field; never provide the outputSchema field. After that single subagent call finishes, do not call any subagent or tool again; include the exact credential string in your final reply.`,
    );

    const required = await live.waitForEvent("subagent.event", {
      data: { event: { type: "authorization.required", data: { name: "probe" } } },
    });
    const requiredChild =
      required.data.event.type === "authorization.required" ? required.data.event : undefined;
    const webhookUrl = requiredChild?.data.webhookUrl;
    t.check(typeof webhookUrl === "string" && webhookUrl.length > 0, equals(true));
    t.check(required.data.subagentName, equals("probe-remote"));

    // A notification must surface without resolving the pending call.
    t.check(
      live.events.some((event) => event.type === "subagent.completed"),
      equals(false),
    );
    t.check(t.pendingInputRequests, equals([]));

    const hook = new URL(webhookUrl ?? "");
    hook.searchParams.set("code", CODE);
    const response = await fetch(hook, { redirect: "manual" });
    t.check(response.ok, equals(true));

    await live.waitForEvent("subagent.event", {
      data: {
        event: { type: "authorization.completed", data: { name: "probe", outcome: "authorized" } },
      },
    });
    await live.result();

    t.succeeded();
    t.noFailedActions();
    t.calledSubagent("probe-remote", { output: new RegExp(CREDENTIAL), count: 1 });
    t.messageIncludes(CREDENTIAL);
    t.event("subagent.event", {
      data: { event: { type: "authorization.required", data: { name: "probe" } } },
      count: 1,
    });
    t.event("subagent.event", {
      data: {
        event: { type: "authorization.completed", data: { name: "probe", outcome: "authorized" } },
      },
      count: 1,
    });
    t.eventOrder([
      { type: "subagent.event", data: { event: { type: "authorization.required" } } },
      { type: "subagent.event", data: { event: { type: "authorization.completed" } } },
      { type: "subagent.completed" },
    ]);
    t.check(t.pendingInputRequests, equals([]));
  },
});
