import type { EveEvalContext } from "eve/evals";

import { fixtureAuthorizationCallback } from "../agent/lib/fake-service.ts";

export type ProbeCase = { readonly kind: "auth" | "hitl" };

export async function runProbe(t: EveEvalContext, probe: ProbeCase): Promise<void> {
  const directive = `WORKFLOW-PROBE-blocking-local-${probe.kind}`;
  const live = await t.start(directive);

  if (probe.kind === "hitl") {
    const requested = await live.waitForEvent("input.requested");
    const response = await t.target.fetch(`/eve/v1/session/${live.sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inputResponses: requested.data.requests.map((request) => ({
          requestId: request.requestId,
          optionId: "approve",
        })),
      }),
    });
    if (!response.ok) throw new Error("Approval delivery failed.");
    const approved = await live.result();
    approved.expectOk();
    approved.messageIncludes("WORKFLOW-HITL:approved");
  } else {
    const required = await live.waitForEvent("authorization.required");
    const url = required.data.authorization?.url;
    if (url === undefined) {
      throw new Error("Authorization probe produced no callback URL.");
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Authorization callback failed (${response.status}).`);
    }

    await live.waitForEvent("authorization.completed");
    (await live.result()).messageIncludes("WORKFLOW-AUTH:authorized");
  }

  t.succeeded();
  t.noFailedActions();
}

export async function runStepAuth(
  t: EveEvalContext,
  scenario: "EXPLICIT" | "IMPLICIT",
): Promise<void> {
  const live = await t.start(`WORKFLOW-STEP-AUTH-${scenario}`);
  const required = await live.waitForEvent("authorization.required");

  const url = fixtureAuthorizationCallback(t.target.url, required.data.authorization?.url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Authorization callback failed (${response.status}).`);
  }

  await live.waitForEvent("authorization.completed");
  (await live.result()).messageIncludes("WORKFLOW-STEP-AUTH:authorized");
  t.noFailedActions();
}

export async function runRejectedStepAuth(t: EveEvalContext): Promise<void> {
  const live = await t.start("WORKFLOW-STEP-AUTH-REJECTED");
  const required = await live.waitForEvent("authorization.required");

  const url = fixtureAuthorizationCallback(t.target.url, required.data.authorization?.url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Authorization callback failed (${response.status}).`);
  }

  const completed = await live.waitForEvent("authorization.completed");
  if (completed.data.outcome !== "failed") {
    throw new Error("A token rejected immediately after sign-in must fail authorization.");
  }

  const repeatedCallback = await fetch(url);
  if (!repeatedCallback.ok) throw new Error("Callback replay was not acknowledged.");
  (await live.result()).event("authorization.required", { count: 1 });
}
