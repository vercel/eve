// @linux-only: signed inbox handle (crypto, World API)
import { generateKeyPairSync } from "node:crypto";
import { expect, it, vi } from "vitest";

import { issueInboxHandle } from "#execution/session-inbox/handle.js";
import { resumeRunnableHook } from "#execution/session-inbox/owner.js";
import { getWorld, setWorld } from "#internal/workflow/runtime.js";

it("reuses a signed inbox with the bundled SDK without another lookup", async () => {
  const originalWorld = await getWorld();
  const { publicKey } = generateKeyPairSync("x25519");
  const hook = {
    runId: "wrun_inbox",
    hookId: "hook_inbox",
    token: "inbox-token",
    ownerId: "team_test",
    projectId: "prj_test",
    environment: "preview",
    specVersion: 8,
    createdAt: new Date(),
    resumeContext: {
      deploymentId: "dpl_test",
      workflowName: "session",
      runSpecVersion: 8,
      workflowCoreVersion: "5.3.0",
      encryptionPublicKey: Buffer.from(
        publicKey.export({ format: "jwk" }).x!,
        "base64url",
      ).toString("base64"),
    },
    resumeCapabilities: { hookResumeDedupVersion: 1 },
  };
  const getByToken = vi.fn().mockResolvedValue(hook);
  const createEvent = vi.fn().mockResolvedValue({});
  const queue = vi.fn().mockResolvedValue({ messageId: "message_test" });
  const getEncryptionKeyForRun = vi.fn();
  vi.stubEnv("EVE_INBOX_HANDLE_SECRET", "test-inbox-key-with-at-least-32-characters");
  setWorld({
    specVersion: 8,
    capabilities: { deploymentAffinity: true, resolvedHookResume: true },
    hooks: { getByToken },
    events: { create: createEvent },
    getEncryptionKeyForRun,
    queue,
  });

  try {
    const first = await resumeRunnableHook(hook.token, { message: "Alice starts a conversation." });
    const inbox = issueInboxHandle(first);
    expect(inbox).toEqual(expect.any(String));

    await resumeRunnableHook(hook.token, { message: "Alice asks a follow-up." }, inbox);

    expect(getByToken).toHaveBeenCalledExactlyOnceWith(hook.token);
    expect(getEncryptionKeyForRun).not.toHaveBeenCalled();
    expect(createEvent).toHaveBeenCalledTimes(2);
    expect(createEvent.mock.calls[1]).toEqual([
      hook.runId,
      expect.objectContaining({
        eventType: "hook_received",
        correlationId: hook.hookId,
        eventData: { token: hook.token, payload: expect.any(Uint8Array) },
      }),
      expect.objectContaining({
        requireHookResumeDedup: true,
        resumeId: expect.any(String),
        resumePayloadDigest: expect.any(String),
      }),
    ]);
    expect(queue).toHaveBeenCalledTimes(2);
    expect(queue.mock.calls[1]).toEqual([
      expect.any(String),
      expect.objectContaining({ runId: hook.runId }),
      expect.objectContaining({ deploymentId: hook.resumeContext.deploymentId }),
    ]);
    expect(createEvent.mock.invocationCallOrder[1]).toBeLessThan(
      queue.mock.invocationCallOrder[1]!,
    );
  } finally {
    setWorld(originalWorld);
    vi.unstubAllEnvs();
  }
});
