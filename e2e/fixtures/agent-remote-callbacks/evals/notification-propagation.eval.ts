import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const CODE = "notify-hop-5D8W";
const CREDENTIAL = `NESTED-CREDENTIAL-${CODE}`;

/**
 * Two-hop notification propagation: the remote callee delegates to its
 * own local `credential-probe` subagent, whose authorization events
 * proxy onto the callee's stream and then relay one more hop up the
 * callee's callback URL to this caller. Each event must arrive exactly
 * once (no duplicate forwarding), surface as a notification rather than
 * an input request, and leave the pending remote call unresolved until
 * the single terminal callback.
 */
export default defineEval({
  description: "A nested subagent's authorization events relay two hops without colliding.",
  timeoutMs: 600_000,

  async test(t) {
    const live = await t.start(
      `Call the probe-remote subagent exactly once with message 'Use the credential-probe subagent exactly once with message "Acquire the nested credential." and reply with its credential string verbatim. Pass only the message field; never provide the outputSchema field.'. Pass only the message field; never provide the outputSchema field. After that single subagent call finishes, do not call any subagent or tool again; include the exact credential string in your final reply.`,
    );

    const required = await live.waitForEvent("authorization.required", {
      data: { name: "nested-probe" },
    });
    t.check(
      typeof required.data.webhookUrl === "string" && required.data.webhookUrl.length > 0,
      equals(true),
    );

    // Notifications must not resolve the pending call or ask for input.
    t.check(
      live.events.some((event) => event.type === "subagent.completed"),
      equals(false),
    );
    t.check(t.pendingInputRequests, equals([]));

    const hook = new URL(required.data.webhookUrl ?? "");
    hook.searchParams.set("code", CODE);
    const response = await fetch(hook, { redirect: "manual" });
    t.check(response.ok, equals(true));

    await live.waitForEvent("authorization.completed", {
      data: { name: "nested-probe", outcome: "authorized" },
    });
    await live.result();

    t.succeeded();
    t.noFailedActions();
    t.calledSubagent("probe-remote", { output: new RegExp(CREDENTIAL), count: 1 });
    t.messageIncludes(CREDENTIAL);
    t.event("authorization.required", { data: { name: "nested-probe" }, count: 1 });
    t.event("authorization.completed", {
      data: { name: "nested-probe", outcome: "authorized" },
      count: 1,
    });
    t.eventOrder([
      { type: "authorization.required", data: { name: "nested-probe" } },
      { type: "authorization.completed", data: { name: "nested-probe" } },
      { type: "subagent.completed" },
    ]);
    t.check(t.pendingInputRequests, equals([]));
  },
});
