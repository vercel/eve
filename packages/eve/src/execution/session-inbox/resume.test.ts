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

/** Vercel-shaped: owners run on their own deployment, so any eve version is runnable. */
function vercelWorld() {
  return {
    capabilities: { deploymentAffinity: true },
    runs: {
      get: vi.fn(async (runId: string) => ({ attributes: {}, deploymentId: "dpl_owner", runId })),
    },
  };
}

/** A World without deployment affinity; owner runs record `ownerEveVersion`. */
function singleDeploymentWorld(ownerEveVersion: string | undefined) {
  return {
    runs: {
      get: vi.fn(async (runId: string) => ({
        attributes: ownerEveVersion === undefined ? {} : { "$eve.version": ownerEveVersion },
        deploymentId: "dpl_owner",
        runId,
      })),
    },
  };
}

const fetchMock = vi.fn<typeof fetch>();

/** What `HEAD https://<deployment url>` answers for the owner's deployment. */
function deploymentAnswers(status: number, headers: Record<string, string> = {}) {
  fetchMock.mockResolvedValue(new Response(null, { headers, status }));
}

function deploymentNotFound() {
  deploymentAnswers(404, { "x-vercel-error": "DEPLOYMENT_NOT_FOUND" });
}

/**
 * The default owner's run id. Ingress remembers runnable owners for the life of
 * the process, so every test gets its own owner.
 */
let owner = "";
let ownerCount = 0;

beforeEach(() => {
  ownerCount += 1;
  owner = `owner-${ownerCount}`;
  vi.stubGlobal("fetch", fetchMock);
  getWorldMock.mockResolvedValue(vercelWorld());
  getHookByTokenMock.mockImplementation(async (token: string) => {
    if (!token.startsWith(sessionInboxHookToken(""))) throw new HookNotFoundError(token);
    return sessionHook(owner, token, { sessionId: "session-1" });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  fetchMock.mockReset();
  getHookByTokenMock.mockReset();
  getWorldMock.mockReset();
  resumeHookMock.mockReset();
});

describe("session inbox resume", () => {
  it("resumes the current owner while preserving public session identity", async () => {
    const token = sessionCommandHookToken("session-1");
    const hook = sessionHook(owner, token, { sessionId: "session-1" });
    resumeHookMock.mockResolvedValue(hook);

    const receipt = await resumeSessionInbox(token, {
      deliveryId: "clear-delivery",
      kind: "clear",
    });
    expect(receipt.ownerRunId).toBe(owner);
    await expect(receipt.sessionId).resolves.toBe("session-1");
    expect(resumeHookMock).toHaveBeenCalledWith(sessionInboxHookToken(token), {
      deliveryId: "clear-delivery",
      kind: "clear",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("owner on another deployment", () => {
    /** The default owner, pinned to `deploymentUrl` on another deployment, built by this eve version. */
    function ownerOn(
      world: ReturnType<typeof vercelWorld> | ReturnType<typeof singleDeploymentWorld>,
      deploymentUrl: string | undefined,
    ) {
      const attributes: Record<string, string> = {
        "$eve.version": resolveInstalledPackageInfo().version,
      };
      if (deploymentUrl !== undefined) attributes["$eve.deployment_url"] = deploymentUrl;
      world.runs.get.mockImplementation(async (runId: string) => ({
        attributes,
        deploymentId: "dpl_owner",
        runId,
      }));
      getWorldMock.mockResolvedValue(world);
      const hook = sessionHook(owner, `channel:${owner}`, { sessionId: "session-1" });
      getHookByTokenMock.mockResolvedValue(hook);
      resumeHookMock.mockResolvedValue(hook);
      return { token: `channel:${owner}`, world };
    }

    const send = (token: string) =>
      resumeSessionInbox(token, { kind: "send", payload: { message: "Alice follows up." } });

    it.each([
      ["an affinity World returning 404", () => vercelWorld(), 404, "DEPLOYMENT_NOT_FOUND"],
      ["an affinity World returning 410", () => vercelWorld(), 410, "DEPLOYMENT_DELETED"],
      ["a single-build World", () => singleDeploymentWorld(undefined), 404, "DEPLOYMENT_NOT_FOUND"],
    ] as const)(
      "refuses an owner whose deployment was deleted on %s",
      async (_name, makeWorld, status, code) => {
        const { token } = ownerOn(makeWorld(), `${owner}.vercel.app`);
        deploymentAnswers(status, { "x-vercel-error": code });

        const refusal = await send(token).catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(StrandedSessionOwnerError);
        expect(refusal).toMatchObject({ ownerRunId: owner });
        expect(fetchMock).toHaveBeenCalledWith(
          `https://${owner}.vercel.app/eve/v1/health`,
          expect.objectContaining({ method: "HEAD", redirect: "manual" }),
        );
        expect(resumeHookMock).not.toHaveBeenCalled();
      },
    );

    it("shares a deletion verdict across owners until the probe expires", async () => {
      const { token } = ownerOn(vercelWorld(), "deleted-once.vercel.app");
      deploymentNotFound();
      await expect(send(token)).rejects.toBeInstanceOf(StrandedSessionOwnerError);

      owner = `${owner}-successor`;
      const successor = ownerOn(vercelWorld(), "deleted-once.vercel.app");
      fetchMock.mockReset();
      await expect(send(successor.token)).rejects.toBeInstanceOf(StrandedSessionOwnerError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("accepts input again after a deleted deployment is restored", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const { token } = ownerOn(vercelWorld(), `${owner}.vercel.app`);
      deploymentNotFound();
      await expect(send(token)).rejects.toBeInstanceOf(StrandedSessionOwnerError);
      deploymentAnswers(200);
      vi.advanceTimersByTime(30_001);
      await expect(send(token)).resolves.toMatchObject({ ownerRunId: owner });
      expect(resumeHookMock).toHaveBeenCalledOnce();
    });

    it.each([
      ["a live deployment", () => deploymentAnswers(302, { location: "https://vercel.com/login" })],
      ["a server error", () => deploymentAnswers(503)],
      ["a 404 that is not a deleted deployment", () => deploymentAnswers(404)],
      ["a 410 that is not a deleted deployment", () => deploymentAnswers(410)],
      [
        "a live route with a deletion header",
        () => deploymentAnswers(200, { "x-vercel-error": "DEPLOYMENT_DELETED" }),
      ],
      [
        "a probe that times out",
        () => fetchMock.mockRejectedValue(new DOMException("timeout", "TimeoutError")),
      ],
    ])("delivers to an owner behind %s", async (_name, answer) => {
      const { token } = ownerOn(vercelWorld(), `${owner}.vercel.app`);
      answer();

      await expect(send(token)).resolves.toMatchObject({ ownerRunId: owner });
      expect(resumeHookMock).toHaveBeenCalledOnce();
    });

    it("shares live probes briefly, then detects a deployment deleted after the first delivery", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const { token, world } = ownerOn(vercelWorld(), `${owner}.vercel.app`);
      deploymentAnswers(200);
      await Promise.all([send(token), send(token)]);
      expect(fetchMock).toHaveBeenCalledOnce();

      deploymentNotFound();
      await send(token);
      expect(fetchMock).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(30_001);
      await expect(send(token)).rejects.toBeInstanceOf(StrandedSessionOwnerError);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(world.runs.get).toHaveBeenCalledTimes(3);
    });

    it("refreshes an owner's identity after its successor boot records a URL", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const world = vercelWorld();
      const { token } = ownerOn(world, undefined);
      await send(token);
      ownerOn(world, `${owner}.vercel.app`);
      deploymentNotFound();
      vi.advanceTimersByTime(30_001);
      await expect(send(token)).rejects.toBeInstanceOf(StrandedSessionOwnerError);
      expect(resumeHookMock).toHaveBeenCalledOnce();
    });

    it.each([
      "localhost",
      "127.0.0.1",
      "example.com",
      "owner.vercel.app@127.0.0.1",
      "owner.vercel.app/path",
      "owner.vercel.app:8080",
    ])("does not fetch an invalid deployment host: %s", async (host) => {
      const { token } = ownerOn(vercelWorld(), host);
      await expect(send(token)).resolves.toMatchObject({ ownerRunId: owner });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("never probes its own deployment", async () => {
      vi.stubEnv("VERCEL_URL", "self.vercel.app");
      const { token } = ownerOn(vercelWorld(), "self.vercel.app");

      await expect(send(token)).resolves.toMatchObject({ ownerRunId: owner });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("preserves a legacy owner with no deployment URL because deletion cannot be established", async () => {
      const { token } = ownerOn(vercelWorld(), undefined);

      await expect(send(token)).resolves.toMatchObject({ ownerRunId: owner });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("reads a runnable owner's version once per process", async () => {
    const world = singleDeploymentWorld(resolveInstalledPackageInfo().version);
    getWorldMock.mockResolvedValue(world);
    const hook = sessionHook(owner, "channel:runnable", { sessionId: "session-1" });
    getHookByTokenMock.mockResolvedValue(hook);
    resumeHookMock.mockResolvedValue(hook);

    await resumeSessionInbox("channel:runnable", { deliveryId: "clear-delivery", kind: "clear" });
    await resumeSessionInbox("channel:runnable", {
      deliveryId: "compact-delivery",
      kind: "compact",
    });

    expect(world.runs.get).toHaveBeenCalledOnce();
    expect(resumeHookMock).toHaveBeenNthCalledWith(1, sessionInboxHookToken("channel:runnable"), {
      deliveryId: "clear-delivery",
      kind: "clear",
    });
    expect(resumeHookMock).toHaveBeenNthCalledWith(2, sessionInboxHookToken("channel:runnable"), {
      deliveryId: "compact-delivery",
      kind: "compact",
    });
  });

  it("resolves a saved public address through the stable token", async () => {
    const token = sessionCommandHookToken("session-1");
    const hook = sessionHook(owner, token, { sessionId: "session-1" });
    resumeHookMock.mockResolvedValue(hook);

    await resumeSessionInbox(
      { sessionId: "session-1" },
      { deliveryId: "compact-delivery", kind: "compact" },
    );
    expect(resumeHookMock).toHaveBeenCalledWith(sessionInboxHookToken(token), {
      deliveryId: "compact-delivery",
      kind: "compact",
    });
  });
  it("does not hydrate metadata until an accepted alias caller asks for identity", async () => {
    const metadata = vi.fn(() => Promise.resolve({ sessionId: "anchor" }));
    const acceptance = Promise.withResolvers<{
      readonly runId: string;
      readonly metadata: Promise<unknown>;
    }>();
    resumeHookMock.mockReturnValue(acceptance.promise);
    const delivery = resumeSessionInbox("channel:alias", {
      deliveryId: "clear-delivery",
      kind: "clear",
    });
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
    const receipt = await resumeSessionInbox(
      { sessionId: "anchor" },
      { deliveryId: "clear-delivery", kind: "clear" },
    );
    await expect(receipt.sessionId).resolves.toBe("anchor");
  });

  it("does not substitute the executor for missing session identity", async () => {
    resumeHookMock.mockResolvedValue({ runId: "successor", metadata: Promise.resolve(undefined) });
    const receipt = await resumeSessionInbox("alias", {
      deliveryId: "clear-delivery",
      kind: "clear",
    });
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
    expect(refusal).toMatchObject({ eveVersion: "0.0.1", ownerRunId: owner });
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
    expect(refusal).toMatchObject({ eveVersion: undefined, ownerRunId: owner });
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
      throw new DevelopmentRunUnavailableError({ availability: "dormant", runId: owner });
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
