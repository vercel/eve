import { defineEval } from "eve/evals";

/**
 * Principal forwarding across a real remote-agent hop, end to end. The
 * fixture deployment plays both sides: `remote-loopback` dynamically selects
 * a `defineRemoteAgent({ forwardPrincipal: true })` pointing back at this
 * deployment, whose authored eve channel trusts principals only from the
 * hop's `router-app` bearer (`trustedForwarders`).
 *
 * Two turns give the parent session *distinct* principals: turn one starts
 * the session as the fixed `user:e2e-user` (pinning it as the initiator),
 * turn two continues it as `user:e2e-user-2` via the second fixture bearer
 * and dispatches the hop. The child session's `whoami` marker can therefore
 * only show `current=e2e-user-2 initiator=e2e-user` — with
 * `forwarded-by=router-app`, the receiver-stamped audit attribute — if both
 * principals crossed the wire independently, the gate accepted the
 * forwarder, and the replacement reached the child runtime. Without
 * forwarding the child would report the transport caller,
 * `service:router-app`, for both.
 */
const FORWARDED_MARKER =
  "WHOAMI current=user:e2e-user-2 initiator=user:e2e-user forwarded-by=router-app";

export default defineEval({
  tags: ["real-model"],
  description:
    "Dynamic remote-agent selection and principal forwarding: the child session runs as the parent's end user, with the distinct initiator preserved and the forwarder stamped.",
  async test(t) {
    await t.send("Reply with the single word: ready.");

    await t.send(
      "Use the remote-loopback agent with this exact message and nothing else (no outputSchema): 'Run the whoami tool and reply with only its marker string, verbatim.' When it returns, reply with the agent's exact output included verbatim.",
      { headers: { authorization: "Bearer e2e-principal-forwarding-second-user" } },
    );

    t.succeeded();
    t.calledSubagent("remote-loopback", {
      output: /WHOAMI current=user:e2e-user-2 initiator=user:e2e-user forwarded-by=router-app/,
    });
    t.messageIncludes(FORWARDED_MARKER);
  },
});
