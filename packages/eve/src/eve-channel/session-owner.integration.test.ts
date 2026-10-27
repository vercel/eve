import { expect, it } from "vitest";

import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { recordHttpSessionOwner, isHttpSessionOwner } from "#eve-channel/session-owner.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

it("persists HTTP ownership through the workflow stream transport before the first message", async () => {
  const runtime = await createTestRuntime({ agent: { name: "http-owner" } });
  const alice = {
    attributes: {},
    authenticator: "app",
    issuer: "workspace",
    principalId: "alice",
    principalType: "user",
  };
  await runtime.run(async () => {
    const workflow = createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });
    const handle = await workflow.createSession({
      adapter: { kind: "http" },
      auth: alice,
      input: {},
    });
    await expect(isHttpSessionOwner(handle.sessionId, alice)).resolves.toBe(false);
    await recordHttpSessionOwner(handle.sessionId, alice);
    await expect(isHttpSessionOwner(handle.sessionId, alice)).resolves.toBe(true);
    await expect(
      isHttpSessionOwner(handle.sessionId, { ...alice, principalId: "bob" }),
    ).resolves.toBe(false);
  });
}, 15_000);
