import { expect, it } from "vitest";

import type { SubscriptionBinding, SubscriptionEvent } from "./state.js";
import { isHeldByOlderDeployment } from "./stale-deployment.js";

const bindingOn = (deploymentId?: string): SubscriptionBinding => ({
  id: "binding-1",
  source: {
    kind: "channel",
    name: "github",
    event: "checks_finished",
    key: "k",
    input: {},
    ttlMs: null,
  },
  sessionId: "session-1",
  executionPrincipal: "rui",
  auth: null,
  ...(deploymentId !== undefined && { deploymentId }),
});
const eventOn = (acceptedDeploymentId?: string): SubscriptionEvent => ({
  id: "e1",
  data: {},
  ...(acceptedDeploymentId !== undefined && { acceptedDeploymentId }),
});

it("is held by an older deployment only when both ids are set and differ", () => {
  expect(isHeldByOlderDeployment(bindingOn("dpl_a"), eventOn("dpl_b"))).toBe(true);
});

it("is current when both deployments are the same", () => {
  expect(isHeldByOlderDeployment(bindingOn("dpl_a"), eventOn("dpl_a"))).toBe(false);
});

it.each([
  ["the binding", undefined, "dpl_b"],
  ["the event", "dpl_a", undefined],
  ["both", undefined, undefined],
])("is current when %s carries no deployment id", (_name, held, accepted) => {
  expect(isHeldByOlderDeployment(bindingOn(held), eventOn(accepted))).toBe(false);
});
