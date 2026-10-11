import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { StrandedSessionOwnerError } from "#execution/session-inbox/owner.js";
import { resumeSessionInbox, SessionHandoffPendingError } from "#execution/session-inbox/resume.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { DevelopmentRunUnavailableError } from "#internal/workflow/development-run-unavailable-error.js";

const getHookByTokenMock = vi.fn();
const getWorldMock = vi.fn();
const resumeHookMock = vi.fn();

vi.mock("#internal/workflow/runtime.js", () => ({
  getHookByToken: (...args: unknown[]) => getHookByTokenMock(...args),
  getWorld: (...args: unknown[]) => getWorldMock(...args),
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
}));

/** Vercel-shaped: owners run on their own deployment, so ingress resumes by token without a lookup. */
const vercelWorld = { capabilities: { deploymentAffinity: true } };

/** A World without deployment affinity; owner runs record `ownerEveVersion`. */
function singleDeploymentWorld(ownerEveVersion: string | undefined) {
  return {
    runs: {
      get: vi.fn(async (runId: string) => ({
        attributes: ownerEveVersion === undefined ? {} : { "$eve.version": ownerEveVersion },
        runId,
      })),
    },
  };
}

beforeEach(() => {
  getWorldMock.mockResolvedValue(vercelWorld);
  getHookByTokenMock.mockImplementation(async (token: string) => {
    if (!token.startsWith(sessionInboxHookToken(""))) throw new HookNotFoundError(token);
    return sessionHook("owner-2", token, { sessionId: "session-1" });
  });
});

afterEach(() => {
  getHookByTokenMock.mockReset();
  getWorldMock.mockReset();
  resumeHookMock.mockReset();
});

describe("session inbox resume", () => {
  it("resumes the current owner while preserving public session identity", async () => {
    const token = sessionCommandHookToken("session-1");
    const hook = sessionHook("owner-2", token, { sessionId: "session-1" });
    resumeHookMock.mockResolvedValue(hook);

    const receipt = await resumeSessionInbox(token, { kind: "clear" });
    expect(receipt.ownerRunId).toBe("owner-2");
    await expect(receipt.sessionId).resolves.toBe("session-1");
    expect(resumeHookMock).toHaveBeenCalledWith(sessionInboxHookToken(token), { kind: "clear" });
    expect(getHookByTokenMock).not.toHaveBeenCalled();
  });

  it("reads a runnable owner's version once per process", async () => {
    const world = singleDeploymentWorld(resolveInstalledPackageInfo().version);
    getWorldMock.mockResolvedValue(world);
    const hook = sessionHook("owner-runnable", "channel:runnable", { sessionId: "session-1" });
    getHookByTokenMock.mockResolvedValue(hook);
    resumeHookMock.mockResolvedValue(hook);

    await resumeSessionInbox("channel:runnable", { kind: "clear" });
    await resumeSessionInbox("channel:runnable", { kind: "compact" });

    expect(world.runs.get).toHaveBeenCalledOnce();
    expect(resumeHookMock).toHaveBeenNthCalledWith(1, sessionInboxHookToken("channel:runnable"), {
      kind: "clear",
    });
    expect(resumeHookMock).toHaveBeenNthCalledWith(2, sessionInboxHookToken("channel:runnable"), {
      kind: "compact",
    });
  });

  it("resolves a saved public address through the stable token", async () => {
    const token = sessionCommandHookToken("session-1");
    const hook = sessionHook("owner-2", token, { sessionId: "session-1" });
    resumeHookMock.mockResolvedValue(hook);

    await resumeSessionInbox({ sessionId: "session-1" }, { kind: "compact" });
    expect(resumeHookMock).toHaveBeenCalledWith(sessionInboxHookToken(token), { kind: "compact" });
  });
  it("does not hydrate metadata until an accepted alias caller asks for identity", async () => {
    const metadata = vi.fn(() => Promise.resolve({ sessionId: "anchor" }));
    const acceptance = Promise.withResolvers<{
      readonly runId: string;
      readonly metadata: Promise<unknown>;
    }>();
    resumeHookMock.mockReturnValue(acceptance.promise);
    const delivery = resumeSessionInbox("channel:alias", { kind: "clear" });
    expect(metadata).not.toHaveBeenCalled();
    acceptance.resolve({
      runId: "successor",
      get metadata() {
        return metadata();
      },
    });
    const receipt = await delivery;
    expect(metadata).not.toHaveBeenCalled();
    await expect(receipt.sessionId).resolves.toBe("anchor");
    await expect(receipt.sessionId).resolves.toBe("anchor");
    expect(metadata).toHaveBeenCalledOnce();
    expect(resumeHookMock).toHaveBeenCalledOnce();
  });

  it("never reads metadata for a known session address", async () => {
    resumeHookMock.mockResolvedValue({
      runId: "successor",
      get metadata() {
        throw new Error("Metadata must not be read");
      },
    });
    const receipt = await resumeSessionInbox({ sessionId: "anchor" }, { kind: "clear" });
    await expect(receipt.sessionId).resolves.toBe("anchor");
  });

  it("does not substitute the executor for missing session identity", async () => {
    resumeHookMock.mockResolvedValue({ runId: "successor", metadata: Promise.resolve(undefined) });
    const receipt = await resumeSessionInbox("alias", { kind: "clear" });
    await expect(receipt.sessionId).rejects.toThrow("command accepted");
    expect(resumeHookMock).toHaveBeenCalledOnce();
  });

  it("refuses a retired owner before committing the command", async () => {
    getWorldMock.mockResolvedValue(singleDeploymentWorld("0.0.1"));

    const refusal = await resumeSessionInbox("channel:alias", {
      kind: "send",
      payload: { message: "Alice follows up." },
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(StrandedSessionOwnerError);
    expect(refusal).toMatchObject({ eveVersion: "0.0.1", ownerRunId: "owner-2" });
    await expect((refusal as StrandedSessionOwnerError).hook?.metadata).resolves.toEqual({
      sessionId: "session-1",
    });
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("refuses an owner that recorded no eve version as retired", async () => {
    getWorldMock.mockResolvedValue(singleDeploymentWorld(undefined));

    const refusal = await resumeSessionInbox("channel:alias", {
      kind: "send",
      payload: { message: "Alice follows up." },
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(StrandedSessionOwnerError);
    expect(refusal).toMatchObject({ eveVersion: undefined, ownerRunId: "owner-2" });
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it.each([
    ["retires a dormant eve dev run another eve version built", "0.0.1", true],
    ["keeps a dormant eve dev run this eve version built", undefined, false],
  ])("%s", async (_name, ownerEveVersion, stranded) => {
    getWorldMock.mockResolvedValue(
      singleDeploymentWorld(ownerEveVersion ?? resolveInstalledPackageInfo().version),
    );
    // The `eve dev` World refuses every hook lookup for a dormant run, including the resume's own.
    const dormant = async (token: string) => {
      if (!token.startsWith(sessionInboxHookToken(""))) throw new HookNotFoundError(token);
      throw new DevelopmentRunUnavailableError({ availability: "dormant", runId: "owner-1" });
    };
    getHookByTokenMock.mockImplementation(dormant);
    resumeHookMock.mockImplementation(dormant);

    const refusal = await resumeSessionInbox(
      { sessionId: "session-1" },
      { kind: "send", payload: { message: "Bob checks in." } },
    ).catch((error: unknown) => error);

    // A same-version dormant run may resume with `eve dev --resume`, so it is never ended.
    expect(refusal).toBeInstanceOf(
      stranded ? StrandedSessionOwnerError : DevelopmentRunUnavailableError,
    );
    if (stranded) expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("does not report a handoff that outlives the retry window as an unowned address", async () => {
    vi.useFakeTimers();
    try {
      resumeHookMock.mockRejectedValue(new HookNotFoundError("inbox"));
      getHookByTokenMock.mockImplementation(async (token: string) =>
        sessionHook("releasing-owner", token, {}),
      );

      const delivery = resumeSessionInbox("channel:alias", {
        kind: "send",
        payload: { message: "Alice asks about the release." },
      }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(6_000);

      await expect(delivery).resolves.toBeInstanceOf(SessionHandoffPendingError);
    } finally {
      vi.useRealTimers();
    }
  });
});

function sessionHook(runId: string, token: string, metadata: Record<string, unknown>) {
  return {
    hookId: `hook-${runId}`,
    metadata: Promise.resolve(metadata),
    runId,
    specVersion: 6,
    token,
  };
}
