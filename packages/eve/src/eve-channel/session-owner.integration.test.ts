import { expect, it } from "vitest";

import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { isHttpSessionOwner } from "#eve-channel/session-owner.js";
import { getRun } from "#internal/workflow/runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

it("retains creator ownership before the first message and after external cancellation", async () => {
  const runtime = await createTestRuntime({ agent: { name: "http-owner" } });
  const alice = {
    attributes: {},
    authenticator: "app",
    issuer: "workspace",
    principalId: "alice",
    principalType: "user",
  };
  const bob = { ...alice, principalId: "bob" };
  await runtime.run(async () => {
    const workflow = createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });
    const handle = await workflow.createSession({
      adapter: { kind: "http" },
      audienceAuth: alice,
      auth: bob,
      input: {},
    });
    await expect(isHttpSessionOwner(handle.sessionId, alice)).resolves.toBe(true);
    await expect(isHttpSessionOwner(handle.sessionId, bob)).resolves.toBe(false);
    await getRun(handle.sessionId).cancel();
    await expect(isHttpSessionOwner(handle.sessionId, alice)).resolves.toBe(true);
    await expect(isHttpSessionOwner(handle.sessionId, bob)).resolves.toBe(false);
  });
}, 15_000);
