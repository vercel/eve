import { defineEval } from "eve/evals";

/**
 * Principal forwarding across a real remote-agent hop, end to end. The
 * fixture deployment plays both sides: `remote-loopback` is a
 * `defineRemoteAgent({ forwardPrincipal: true })` pointing back at this
 * deployment, whose authored eve channel accepts principals only from the
 * hop's `router-app` bearer (`acceptPrincipalFrom`).
 *
 * The eval driver's session runs as the fixed `user:e2e-user` principal (the
 * channel's catch-all auth entry). The child session's `whoami` marker can
 * therefore only name that user — with `forwarded-by=router-app`, the
 * receiver-stamped audit attribute — if the principal crossed the hop, the
 * gate accepted the forwarder, and the replacement reached the child's
 * runtime. Without forwarding the child would report the transport caller,
 * `service:router-app`, instead.
 */
const FORWARDED_MARKER = "WHOAMI principal=user:e2e-user forwarded-by=router-app";

export default defineEval({
  description:
    "Remote-agent principal forwarding: the child session runs as the parent's end user, stamped with the forwarder.",
  async test(t) {
    await t.send(
      "Use the remote-loopback agent with this exact message and nothing else (no outputSchema): 'Run the whoami tool and reply with only its marker string, verbatim.' When it returns, reply with the agent's exact output included verbatim.",
    );

    t.succeeded();
    t.calledSubagent("remote-loopback", {
      output: /WHOAMI principal=user:e2e-user forwarded-by=router-app/,
    });
    t.messageIncludes(FORWARDED_MARKER);
  },
});
